import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Guild,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type UserSelectMenuInteraction,
  type VoiceBasedChannel,
  type VoiceState,
} from 'discord.js';
import { config } from './config.js';
import { cache } from './cache.js';
import { store } from './db.js';
import type { CreatorChannelConfig, GuildSettings, Product, Room } from './types.js';
import type { PaymentCreationResult } from './services/payment-service.js';
import { formatVnd } from './utils.js';
import { createDonationPayment, createProductPayment, settleSepayWebhook } from './services/payment-service.js';

/** Phòng vừa tạo được bảo vệ khỏi sweeper trong khoảng này để bot kịp move host vào. */
const ROOM_CREATION_GRACE_MS = 90_000;
/** Chu kỳ quét phòng mồ côi / phòng trống (kể cả khi bot bỏ lỡ event voice). */
const ROOM_SWEEP_INTERVAL_MS = 30_000;
/** Chu kỳ ping DB + Redis để giữ kết nối ấm, tránh cold-connect làm trễ interaction. */
const KEEPALIVE_INTERVAL_MS = 30_000;
/** Cảnh báo khi bot ack interaction chậm - dấu hiệu sắp dính "didn't respond in time". */
const SLOW_ACK_WARN_MS = 1_200;
/** Các mã lỗi Discord cho biết interaction token đã chết, không cần retry. */
const DEAD_INTERACTION_CODES = new Set([10062, 10008, 40060]);

function isDeveloperUser(userId: string): boolean {
  return config.developerIds.includes(userId);
}

function isAdmin(interaction: Interaction): boolean {
  return isDeveloperUser(interaction.user.id) || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function displayName(member: GuildMember): string {
  return member.displayName || member.user.globalName || member.user.username;
}

function roomName(settings: GuildSettings, member: GuildMember): string {
  const template = settings.roomNameTemplate || "{user}'s room";
  const value = template.replace(/\{user\}/gi, displayName(member)).replace(/\{tag\}/gi, member.user.username);
  return value.slice(0, 100) || `${displayName(member)}'s room`;
}

/** Chỉ đếm người thật. Bot ở lại trong phòng không giữ phòng sống. */
function humanMembers(channel: VoiceBasedChannel): GuildMember[] {
  return [...channel.members.values()].filter((member) => !member.user.bot);
}

/**
 * scryptSync chặn event loop khoảng 100ms mỗi lần gọi. Khi event loop bị chặn,
 * các interaction đang chờ sẽ vượt quá deadline 3 giây của Discord. Dùng bản async.
 */
function passwordDigest(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (error, derived) => error ? reject(error) : resolve(derived.toString('hex')));
  });
}

async function passwordMatches(password: string, room: Room): Promise<boolean> {
  if (!room.passwordHash || !room.passwordSalt) return true;
  const actual = Buffer.from(await passwordDigest(password, room.passwordSalt), 'hex');
  const expected = Buffer.from(room.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export interface GuildMemberView {
  id: string;
  username: string;
  globalName: string;
  displayName: string;
  avatarUrl: string;
  bot: boolean;
  joinedAt: string;
  roleIds: string[];
}

export interface LiveRoomView {
  id: string;
  channelId: string;
  name: string;
  ownerId: string;
  ownerTag: string;
  originalOwnerId: string;
  editable: boolean;
  creatorChannelId: string;
  userLimit: number;
  locked: boolean;
  hidden: boolean;
  passwordEnabled: boolean;
  notifyJoinLeave: boolean;
  createdAt: string;
  members: Array<{ id: string; displayName: string; username: string; avatarUrl: string; bot: boolean }>;
}

export type RoomDashboardAction = 'rename' | 'limit' | 'lock' | 'hide' | 'password' | 'notifications' | 'invite' | 'kick' | 'transfer' | 'delete';

export class SgfBot {
  public readonly client: Client;
  private readonly creatingOwners = new Set<string>();
  private readonly rejectedPasswordLeaves = new Set<string>();
  private readonly passwordAttempts = new Map<string, { count: number; resetAt: number }>();
  private readonly guildMemberSnapshots = new Map<string, { expiresAt: number; data: GuildMemberView[] }>();
  private readonly guildMemberFetches = new Map<string, Promise<GuildMemberView[]>>();
  private readonly guildMemberRetryAt = new Map<string, number>();
  /** Chống xử lý trùng khi có nhiều instance bot cùng token hoặc gateway gửi lặp. */
  private readonly handledInteractions = new Map<string, number>();
  /** Khóa mềm cho mỗi phòng để không xóa/chuyển host hai lần cùng lúc. */
  private readonly roomLocks = new Set<string>();
  /** Phòng đang chờ bot move host vào, không cho sweeper xóa sớm. */
  private readonly roomGrace = new Map<string, number>();
  private expiryTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  private keepAliveTimer?: NodeJS.Timeout;
  private lastError = '';
  private readyAt = '';
  private slowAckCount = 0;
  private deadInteractionCount = 0;
  private rateLimitCount = 0;

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
      // Interaction phải được ack trong 3 giây. Timeout REST ngắn + ít retry giúp lỗi
      // nổi lên ngay thay vì treo hàng đợi và làm chết token của các interaction sau.
      rest: { timeout: 10_000, retries: 1 },
    });
    this.registerListeners();
  }

  // ---------------------------------------------------------------------------
  // Lớp ack interaction
  // Discord chỉ cho 3 giây để ack lần đầu (sau đó token sống 15 phút).
  // Mọi handler phải ack TRƯỚC khi chạm vào DB, cache hay REST.
  // ---------------------------------------------------------------------------

  private static interactionErrorCode(error: unknown): number {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'number' ? code : 0;
  }

  private static isDeadInteraction(error: unknown): boolean {
    return DEAD_INTERACTION_CODES.has(SgfBot.interactionErrorCode(error));
  }

  /** Ack ngay lập tức. Trả về false khi token đã chết để handler dừng sớm. */
  private async ackDefer(interaction: RepliableInteraction, ephemeral = true): Promise<boolean> {
    if (interaction.deferred || interaction.replied) return true;
    const startedAt = Date.now();
    try {
      await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      const elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_ACK_WARN_MS) {
        this.slowAckCount += 1;
        console.warn(`[bot] ack chậm ${elapsed}ms cho ${interaction.type}:${'customId' in interaction ? interaction.customId : ''}. Kiểm tra rate limit hoặc event loop bị chặn.`);
      }
      return true;
    } catch (error) {
      if (SgfBot.isDeadInteraction(error)) {
        this.deadInteractionCount += 1;
        console.warn('[bot] interaction token đã hết hạn trước khi ack được (10062/40060). Panel vẫn dùng lại được bình thường.');
        return false;
      }
      throw error;
    }
  }

  /** Trả lời an toàn ở mọi trạng thái interaction, không bao giờ ném lỗi ra ngoài. */
  private async respond(interaction: RepliableInteraction, payload: { content?: string; embeds?: EmbedBuilder[] }): Promise<void> {
    const body = { content: payload.content ?? '', embeds: payload.embeds ?? [], components: [] };
    try {
      if (interaction.deferred) await interaction.editReply(body);
      else if (interaction.replied) await interaction.followUp({ ...body, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
    } catch (error) {
      if (SgfBot.isDeadInteraction(error)) {
        this.deadInteractionCount += 1;
        return;
      }
      console.warn('[bot] không gửi được phản hồi interaction', error);
    }
  }

  private markInteractionHandled(interactionId: string): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of this.handledInteractions) if (expiresAt <= now) this.handledInteractions.delete(key);
    if (this.handledInteractions.has(interactionId)) return false;
    this.handledInteractions.set(interactionId, now + 15 * 60_000);
    return true;
  }

  async start(): Promise<void> {
    if (!config.discord.token) {
      this.lastError = 'DISCORD_TOKEN is empty. Dashboard-only mode.';
      console.warn(`[bot] ${this.lastError}`);
      return;
    }
    try {
      await this.client.login(config.discord.token);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Discord login failed';
      console.error('[bot] login failed', error);
    }
  }

  /** Dừng mọi timer nền rồi ngắt kết nối gateway. */
  async stop(): Promise<void> {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    await this.client.destroy().catch(() => undefined);
  }

  getGuildAccess(guildId: string): { present: boolean; administrator: boolean } {
    const guild = this.client.guilds.cache.get(guildId);
    const member = guild?.members.me;
    return { present: Boolean(guild), administrator: Boolean(member?.permissions.has(PermissionFlagsBits.Administrator)) };
  }

  getRuntimeStatus() {
    const guilds = [...this.client.guilds.cache.values()];
    return {
      online: this.client.isReady(),
      userTag: this.client.user?.tag || '',
      guildCount: guilds.length,
      userCount: guilds.reduce((total, guild) => total + Math.max(0, guild.memberCount - 1), 0),
      readyAt: this.readyAt,
      lastError: this.lastError,
      oauthConfigured: Boolean(config.discord.clientId && config.discord.clientSecret),
      clientId: config.discord.clientId ? `${config.discord.clientId.slice(0, 4)}…${config.discord.clientId.slice(-4)}` : '',
      clientSecretConfigured: Boolean(config.discord.clientSecret),
      redirectUri: config.discord.redirectUri,
      commandName: 'sgf',
      wsPing: Math.round(this.client.ws.ping),
      slowAckCount: this.slowAckCount,
      deadInteractionCount: this.deadInteractionCount,
      rateLimitCount: this.rateLimitCount,
      trackedRooms: this.roomGrace.size,
    };
  }

  private registerListeners(): void {
    this.client.on(Events.ClientReady, async (client) => {
      this.readyAt = new Date().toISOString();
      this.lastError = '';
      console.log(`[bot] logged in as ${client.user.tag}`);
      for (const guild of client.guilds.cache.values()) {
        await guild.members.fetchMe().catch((error) => console.warn(`[bot] cannot fetch own member in ${guild.id}`, error));
      }
      await this.registerSlashCommands();
      await this.runMaintenance();
      await this.sweepRooms('startup');
      this.expiryTimer = setInterval(() => void this.runMaintenance(), 60_000);
      // Lưới an toàn: kể cả khi bot bỏ lỡ VoiceStateUpdate (mất mạng, restart, downtime
      // của gateway), sweeper vẫn dọn mọi phòng không còn người thật.
      this.sweepTimer = setInterval(() => void this.sweepRooms('interval'), ROOM_SWEEP_INTERVAL_MS);
      // Giữ Postgres/Redis ấm để interaction đầu tiên sau lúc rảnh không phải chờ
      // bắt tay kết nối - đây là nguyên nhân số một của "didn't respond in time".
      this.keepAliveTimer = setInterval(() => void this.keepConnectionsWarm(), KEEPALIVE_INTERVAL_MS);
    });
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      console.warn(`[bot] shard ${shardId} ngắt kết nối (${event.code}). Sẽ dọn phòng lại khi resume.`);
    });
    this.client.on(Events.ShardResume, (shardId) => {
      console.log(`[bot] shard ${shardId} đã resume, chạy sweep bù.`);
      void this.sweepRooms('resume');
    });
    this.client.on(Events.ShardError, (error, shardId) => {
      this.lastError = `shard ${shardId}: ${error.message}`;
      console.error(`[bot] shard ${shardId} lỗi`, error);
    });
    this.client.rest.on('rateLimited', (info) => {
      this.rateLimitCount += 1;
      console.warn(`[bot] rate limited ${info.timeToReset}ms trên ${info.route}. Interaction có thể bị trễ.`);
    });
    this.client.on(Events.GuildCreate, async (guild) => {
      await guild.members.fetchMe().catch((error) => console.warn(`[bot] cannot fetch own member in ${guild.id}`, error));
      await this.registerSlashCommands(guild);
    });
    this.client.on(Events.GuildMemberAdd, (member) => { this.guildMemberSnapshots.delete(member.guild.id); void cache.del(`guild-members:${member.guild.id}`); });
    this.client.on(Events.GuildMemberRemove, (member) => { this.guildMemberSnapshots.delete(member.guild.id); void cache.del(`guild-members:${member.guild.id}`); });
    this.client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
      await this.onVoiceStateUpdate(oldState, newState).catch((error) => console.error('[bot] voice state error', error));
    });
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!this.markInteractionHandled(interaction.id)) return;
      try {
        await this.onInteraction(interaction);
      } catch (error) {
        if (SgfBot.isDeadInteraction(error)) {
          this.deadInteractionCount += 1;
          console.warn('[bot] interaction hết hạn giữa chừng, bỏ qua.');
          return;
        }
        console.error('[bot] interaction error', error);
        if (interaction.isRepliable()) await this.respond(interaction, { content: 'Có lỗi xảy ra, thử lại sau nhé.' });
      }
    });
    this.client.on(Events.ChannelDelete, (channel) => {
      this.roomGrace.delete(channel.id);
      void store.deleteRoomByChannel(channel.id);
    });
  }

  private commandPayloads() {
    const sgfCommand = new SlashCommandBuilder()
      .setName('sgf')
      .setDescription('Voice room, Premium và thanh toán SGF')
      .addSubcommand((subcommand) => subcommand
        .setName('setup')
        .setDescription('Admin: cấu hình đúng kênh bot sẽ sử dụng')
        .addChannelOption((option) => option.setName('control_channel').setDescription('Kênh thông báo chung (tùy chọn)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addChannelOption((option) => option.setName('payment_channel').setDescription('Kênh bot đăng panel Premium và donate').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption((option) => option.setName('premium_role').setDescription('Role Premium được cấp sau thanh toán'))
        .addChannelOption((option) => option.setName('creator_channel').setDescription('Voice channel member sẽ join để tạo phòng').addChannelTypes(ChannelType.GuildVoice))
        .addStringOption((option) => option.setName('creator_mode').setDescription('Quyền chỉnh sửa của phòng được tạo').addChoices({ name: 'Editable - có panel', value: 'editable' }, { name: 'Basic - không chỉnh sửa', value: 'basic' }))
        .addRoleOption((option) => option.setName('allowed_role').setDescription('Role được phép dùng creator. Bỏ trống là tất cả'))
        .addBooleanOption((option) => option.setName('join_leave_log').setDescription('Bật thông báo người vào/rời mặc định'))
        .addBooleanOption((option) => option.setName('auto_host').setDescription('Tự chuyển host khi host rời voice')))
      .addSubcommand((subcommand) => subcommand.setName('panel').setDescription('Admin: đăng panel mua role và donate'))
      .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Admin: xem trạng thái bot/server'))
      .addSubcommand((subcommand) => subcommand.setName('sync').setDescription('Admin: đồng bộ lại slash command'))
      .addSubcommand((subcommand) => subcommand.setName('premium').setDescription('Mở menu mua Premium và donate'))
      .addSubcommand((subcommand) => subcommand.setName('room').setDescription('Mở control panel một phòng voice của bạn'))
      .addSubcommand((subcommand) => subcommand.setName('donate').setDescription('Tạo đơn donate và QR chuyển khoản riêng'))
      .addSubcommand((subcommand) => subcommand.setName('help').setDescription('Xem hướng dẫn dùng bot'));

    return [sgfCommand.toJSON()];
  }

  private async registerSlashCommands(onlyGuild?: Guild): Promise<void> {
    const guilds = onlyGuild ? [onlyGuild] : [...this.client.guilds.cache.values()];
    const commands = this.commandPayloads();
    for (const guild of guilds) {
      await guild.commands.set(commands).catch((error) => {
        this.lastError = error instanceof Error ? error.message : `Cannot register slash commands for ${guild.id}`;
        console.error(`[bot] cannot register commands for ${guild.id}`, error);
      });
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) return this.onSlash(interaction);
    if (interaction.isButton()) return this.onButton(interaction);
    if (interaction.isUserSelectMenu()) return this.onUserSelect(interaction);
    if (interaction.isModalSubmit()) return this.onModal(interaction);
  }

  private async onSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await this.respond(interaction, { content: 'Hãy dùng lệnh này trong một server Discord.' });
      return;
    }
    if (interaction.commandName !== 'sgf') return;
    const subcommand = interaction.options.getSubcommand();
    const developerOnly = ['panel', 'status', 'sync'].includes(subcommand);
    if (developerOnly && !isDeveloperUser(interaction.user.id)) {
      await this.respond(interaction, { content: 'Lệnh này chỉ dành cho Study Voice developers.' });
      return;
    }
    if (subcommand === 'setup' && !isAdmin(interaction)) {
      await this.respond(interaction, { content: 'Lệnh setup chỉ dành cho admin server hoặc Study Voice developers.' });
      return;
    }
    if (subcommand === 'donate') {
      await interaction.showModal(this.donationModal());
      return;
    }

    if (!await this.ackDefer(interaction)) return;
    if (subcommand === 'help') return this.sendHelp(interaction);

    const settings = await store.getSettings(interaction.guild.id, interaction.guild.name);
    if (subcommand === 'premium') {
      const products = await store.listProducts(interaction.guild.id, true);
      const row = this.paymentButtonRow(products);
      const founder = isDeveloperUser(interaction.user.id);
      const entitlement = founder ? undefined : await store.getEntitlement(interaction.guild.id, interaction.user.id);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
        .setTitle('Premium và Donate')
        .setDescription(products.length ? 'Premium cho phép host mở không giới hạn phòng editable. Bản miễn phí được giữ 1 phòng editable trên mỗi server.' : 'Server chưa mở bán gói Premium. Bạn vẫn có thể chọn Donate để ủng hộ.')
        .addFields(
          { name: 'Trạng thái của bạn', value: founder ? 'Founder Premium không giới hạn và không hết hạn' : entitlement ? `Premium đến **${entitlement.expiresAt ? new Date(entitlement.expiresAt).toLocaleDateString('vi-VN') : 'vĩnh viễn'}**` : 'Free - 1 phòng editable trên mỗi server', inline: false },
          { name: 'Gia hạn', value: 'Thanh toán sớm sẽ cộng thêm thời gian kể từ ngày hết hạn hiện tại.', inline: false },
        )
        .setFooter({ text: 'Bot sẽ nhắc gia hạn trước 3 ngày' })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed], components: row ? [row] : [] });
      return;
    }
    if (subcommand === 'room') {
      const currentChannelId = interaction.member instanceof GuildMember ? interaction.member.voice.channelId : '';
      const currentRoom = currentChannelId ? await store.getRoomByChannel(currentChannelId) : undefined;
      const room = currentRoom?.ownerId === interaction.user.id ? currentRoom : await store.getRoomByOwner(interaction.guild.id, interaction.user.id);
      if (!room) {
        await this.respond(interaction, { content: 'Bạn chưa host phòng tạm nào. Hãy vào creator voice channel trước.' });
        return;
      }
      await interaction.editReply({ content: `Bảng điều khiển cho <#${room.channelId}>`, embeds: [this.roomPanelEmbed(room)], components: this.roomButtonRows(room) });
      return;
    }
    if (subcommand === 'setup') return this.runSetup(interaction, settings);
    if (subcommand === 'panel') {
      const result = await this.postPaymentPanel(interaction.guild, settings);
      await interaction.editReply({ content: result });
      return;
    }
    if (subcommand === 'sync') {
      await this.registerSlashCommands(interaction.guild);
      await interaction.editReply({ content: 'Đã đồng bộ command `/sgf` và xóa các slash command cũ bị trùng.' });
      return;
    }
    if (subcommand === 'status') {
      const stats = await store.getStats(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setColor(this.client.isReady() ? 0x22c55e : 0xef4444)
        .setTitle('Trạng thái SGF Bot')
        .addFields(
          { name: 'Bot', value: this.client.isReady() ? 'Online' : 'Offline', inline: true },
          { name: 'Phòng tạm', value: String(stats.activeRooms), inline: true },
          { name: 'Đã thanh toán', value: String(stats.paidCount), inline: true },
          { name: 'Tổng đã nhận', value: formatVnd(stats.paidTotalVnd), inline: true },
          { name: 'Dashboard', value: `[Mở Control Center](${config.publicUrl})`, inline: true },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    }
  }

  private async sendHelp(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'Study Voice Dashboard', iconURL: this.client.user?.displayAvatarURL() })
      .setTitle('Hướng dẫn sử dụng SGF Bot')
      .setDescription('Tất cả slash command được gom dưới command `/sgf`.')
      .addFields(
        { name: 'Tạo phòng', value: 'Vào voice creator đã được admin setup. Bot tạo phòng riêng, chuyển bạn sang phòng mới và đặt bạn làm host.' },
        { name: 'Điều khiển phòng', value: 'Đổi tên\nĐặt giới hạn\nKhóa hoặc ẩn phòng\nMời hoặc kick member\nChuyển host\nBật hoặc tắt thông báo ra vào' },
        { name: 'Premium', value: 'Free được một phòng editable trên mỗi server. Premium theo tháng cho phép mở không giới hạn. Gia hạn được cộng tiếp từ ngày hết hạn.' },
        { name: 'Command thường dùng', value: '`/sgf setup`\n`/sgf room`\n`/sgf premium`\n`/sgf donate`\n`/sgf panel`\n`/sgf status`' },
      )
      .setThumbnail(this.client.user?.displayAvatarURL({ size: 256 }) || null)
      .setFooter({ text: `SGF - ${interaction.guild?.name || 'Discord server'}` })
      .setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('Mở Dashboard').setStyle(ButtonStyle.Link).setURL(config.publicUrl));
    await interaction.editReply({ embeds: [embed], components: [row] });
  }

  private async runSetup(interaction: ChatInputCommandInteraction, currentSettings: GuildSettings): Promise<void> {
    const controlChannel = interaction.options.getChannel('control_channel');
    const paymentChannel = interaction.options.getChannel('payment_channel');
    const premiumRole = interaction.options.getRole('premium_role');
    const creatorChannel = interaction.options.getChannel('creator_channel');
    const creatorMode = interaction.options.getString('creator_mode') as 'basic' | 'editable' | null;
    const allowedRole = interaction.options.getRole('allowed_role');
    const joinLeaveLog = interaction.options.getBoolean('join_leave_log');
    const autoHost = interaction.options.getBoolean('auto_host');
    const patch: Partial<GuildSettings> = {};
    const developer = isDeveloperUser(interaction.user.id);
    if (controlChannel) patch.controlChannelId = controlChannel.id;
    if (developer && paymentChannel) patch.paymentPanelChannelId = paymentChannel.id;
    if (premiumRole) patch.premiumRoleId = premiumRole.id;
    const guildCreatorChannel = creatorChannel ? interaction.guild!.channels.cache.get(creatorChannel.id) : undefined;
    if (guildCreatorChannel?.type === ChannelType.GuildVoice) {
      const existing = currentSettings.creatorChannels.find((item) => item.channelId === guildCreatorChannel.id);
      const creator: CreatorChannelConfig = {
        channelId: guildCreatorChannel.id,
        label: guildCreatorChannel.name,
        mode: creatorMode || existing?.mode || 'editable',
        ...(guildCreatorChannel.parentId ? { categoryId: existing?.categoryId || guildCreatorChannel.parentId } : {}),
        ...(allowedRole ? { allowedRoleId: allowedRole.id } : existing?.allowedRoleId ? { allowedRoleId: existing.allowedRoleId } : {}),
        notifyJoinLeave: joinLeaveLog ?? existing?.notifyJoinLeave ?? false,
        autoTransferOwner: autoHost ?? existing?.autoTransferOwner ?? true,
      };
      patch.creatorChannels = existing
        ? currentSettings.creatorChannels.map((item) => item.channelId === creator.channelId ? creator : item)
        : [...currentSettings.creatorChannels, creator];
    }
    const settings = Object.keys(patch).length ? await store.updateSettings(interaction.guild!.id, patch) : currentSettings;
    const missing = [!settings.paymentPanelChannelId ? 'kênh payment panel' : '', settings.creatorChannels.length === 0 ? 'creator voice channel' : ''].filter(Boolean);
    const complete = missing.length === 0;
    const embed = new EmbedBuilder()
      .setColor(complete ? 0x22c55e : 0xf59e0b)
      .setAuthor({ name: interaction.guild!.name, iconURL: interaction.guild!.iconURL() || undefined })
      .setTitle(complete ? 'Thiết lập đã sẵn sàng' : 'Thiết lập SGF Bot')
      .setDescription('Dùng option `creator_channel` ngay trong lệnh này hoặc mở Dashboard → Voice rooms. Khi member join trigger, bot tự tạo voice riêng, chuyển member sang phòng mới và đặt member làm host.')
      .addFields(
        { name: 'Premium & Donate', value: settings.paymentPanelChannelId ? `<#${settings.paymentPanelChannelId}>` : 'Chưa chọn', inline: true },
        { name: 'Role Premium', value: settings.premiumRoleId ? `<@&${settings.premiumRoleId}>` : 'Không bắt buộc', inline: true },
        { name: 'Creator voice', value: settings.creatorChannels.length ? `${settings.creatorChannels.length} kênh đã cấu hình` : 'Chưa có', inline: true },
        { name: complete ? 'Sẵn sàng' : 'Còn thiếu', value: complete ? 'Có thể dùng `/sgf panel` để đăng bảng thanh toán.' : missing.join('\n') },
      )
      .setFooter({ text: 'Mỗi creator có mode, role, log ra/vào và auto ownership riêng.' })
      .setTimestamp();
    const setupRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('Mở Dashboard').setStyle(ButtonStyle.Link).setURL(config.publicUrl),
      new ButtonBuilder().setLabel('Tài liệu SePay').setStyle(ButtonStyle.Link).setURL('https://developer.sepay.vn/vi/sepay-webhooks/tao-qr-va-form-thanh-toan'),
    );
    await interaction.editReply({ embeds: [embed], components: [setupRow] });
  }

  private async onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot || oldState.channelId === newState.channelId) return;
    const guild = newState.guild;

    if (newState.channelId) {
      const settings = await store.getSettings(guild.id, guild.name);
      const creator = settings.creatorChannels.find((item) => item.channelId === newState.channelId);
      if (creator) {
        await this.createRoomFromTrigger(member, creator, settings, oldState.channelId);
      } else {
        const joinedRoom = await store.getRoomByChannel(newState.channelId);
        if (joinedRoom) {
          const allowed = await this.enforceRoomPassword(member, joinedRoom);
          if (allowed) {
            if (joinedRoom.notifyJoinLeave) await this.sendRoomNotice(joinedRoom, `➡️ <@${member.id}> đã **vào phòng**.`);
            // Host gốc quay lại thì nhận lại quyền host.
            await this.restoreOriginalOwner(joinedRoom, member);
          }
        }
      }
    }

    if (oldState.channelId) {
      const leftRoom = await store.getRoomByChannel(oldState.channelId);
      if (leftRoom) {
        const rejectedKey = `${leftRoom.channelId}:${member.id}`;
        const rejected = this.rejectedPasswordLeaves.delete(rejectedKey);
        if (!rejected && leftRoom.notifyJoinLeave) await this.sendRoomNotice(leftRoom, `⬅️ <@${member.id}> đã **rời phòng**.`);
        // Xóa phòng trống trước, khỏi tốn công chuyển host cho phòng sắp biến mất.
        const removed = await this.removeRoomIfEmpty(leftRoom.channelId, 'Người cuối cùng đã rời phòng');
        if (!removed && leftRoom.ownerId === member.id) await this.autoTransferOwnership(leftRoom);
      }
    }
  }

  /**
   * Trả host về cho người tạo phòng ban đầu khi họ quay lại.
   * Trong lúc họ vắng mặt, host tạm được giao cho người khác để phòng vẫn điều khiển được.
   */
  private async restoreOriginalOwner(room: Room, member: GuildMember): Promise<void> {
    const originalOwnerId = room.originalOwnerId || room.ownerId;
    if (member.id !== originalOwnerId || room.ownerId === originalOwnerId) return;
    const settings = await store.getSettings(room.guildId);
    const creator = settings.creatorChannels.find((item) => item.channelId === room.creatorChannelId);
    if (creator?.autoTransferOwner === false) return;
    try {
      await this.transferOwnership(room, member, 'Host gốc đã quay lại phòng.', { skipLimitCheck: true, keepOriginalOwner: true });
    } catch (error) {
      console.warn(`[bot] không trả lại host gốc cho ${member.id} ở ${room.channelId}`, error);
    }
  }

  private async createRoomFromTrigger(member: GuildMember, creator: CreatorChannelConfig, settings: GuildSettings, previousChannelId: string | null): Promise<void> {
    const key = `${member.guild.id}:${member.id}`;
    if (this.creatingOwners.has(key)) return;
    const distributedLockKey = `room-create:${key}`;
    if (cache.backend !== 'memory' && !await cache.setIfAbsent(distributedLockKey, '1', 20)) return;
    this.creatingOwners.add(key);
    try {
      if (creator.allowedRoleId && !isDeveloperUser(member.id) && !member.roles.cache.has(creator.allowedRoleId) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await member.send(`Bạn cần role <@&${creator.allowedRoleId}> để dùng creator **${creator.label}** trong **${member.guild.name}**.`).catch(() => undefined);
        if (previousChannelId) await member.voice.setChannel(previousChannelId, 'Thiếu role để tạo phòng').catch(() => undefined);
        else await member.voice.disconnect('Thiếu role để tạo phòng').catch(() => undefined);
        return;
      }

      const premium = await this.isPremium(member, settings);
      if (creator.mode === 'basic') {
        const existing = await store.getRoomByOwnerAndCreator(member.guild.id, member.id, creator.channelId);
        // resolveOrForgetRoom chỉ quên record khi kênh thực sự đã bị xóa.
        const existingChannel = existing ? await this.resolveOrForgetRoom(existing) : undefined;
        if (existingChannel) {
          await member.voice.setChannel(existingChannel, 'Dùng lại phòng cơ bản đang có').catch(() => undefined);
          return;
        }
      }

      if (creator.mode === 'editable' && !premium) {
        const editableRooms = (await store.listRoomsByOwner(member.guild.id, member.id)).filter((room) => room.mode === 'editable');
        let firstActiveChannel: VoiceBasedChannel | undefined;
        let firstActiveRoom: Room | undefined;
        for (const room of editableRooms) {
          const roomChannel = await this.resolveOrForgetRoom(room);
          if (roomChannel && !firstActiveChannel) {
            firstActiveChannel = roomChannel;
            firstActiveRoom = room;
          }
        }
        if (firstActiveChannel && firstActiveRoom) {
          await member.voice.setChannel(firstActiveChannel, 'Free chỉ được một phòng editable/server').catch(() => undefined);
          await member.send(`Bản Free giữ tối đa **1 phòng editable/server**. Bot đã chuyển bạn về <#${firstActiveRoom.channelId}>. Premium cho phép mở không giới hạn.`).catch(() => undefined);
          return;
        }
      }

      const parentId = creator.categoryId || settings.defaultRoomCategoryId || member.guild.channels.cache.get(creator.channelId)?.parentId || undefined;
      const channel = await member.guild.channels.create({
        name: roomName(settings, member),
        type: ChannelType.GuildVoice,
        parent: parentId,
        permissionOverwrites: [
          { id: member.guild.roles.everyone.id, allow: ['ViewChannel', 'Connect', 'Speak'] },
          { id: member.id, allow: ['ViewChannel', 'Connect', 'Speak'] },
        ],
        reason: `SGF temporary ${creator.mode} room for ${member.user.tag}`,
      });

      // Phòng mới chưa có ai bên trong. Đánh dấu grace để sweeper không xóa nhầm
      // trong lúc bot còn đang move host và gửi panel.
      this.roomGrace.set(channel.id, Date.now() + ROOM_CREATION_GRACE_MS);

      const room = await store.insertRoom({
        guildId: member.guild.id,
        channelId: channel.id,
        ownerId: member.id,
        ownerTag: member.user.tag,
        originalOwnerId: member.id,
        mode: creator.mode,
        creatorChannelId: creator.channelId,
        controlMessageId: '',
        notifyJoinLeave: Boolean(creator.notifyJoinLeave),
        passwordHash: '',
        passwordSalt: '',
      });

      // Move host TRƯỚC khi gửi panel: nếu move hỏng thì không tốn công gửi panel,
      // và phòng có người ngay nên không bao giờ bị coi là phòng trống.
      try {
        await member.voice.setChannel(channel, 'SGF tạo phòng tạm và chuyển host');
      } catch (error) {
        this.roomGrace.delete(channel.id);
        await store.deleteRoomByChannel(channel.id);
        await channel.delete('Không move được chủ phòng').catch(() => undefined);
        throw new Error('Bot tạo được phòng nhưng không chuyển được member. Kiểm tra quyền Move Members và Connect.', { cause: error });
      }

      let controlMessageId = '';
      try {
        controlMessageId = await this.sendRoomControlPanel(member.guild, room);
      } catch (error) {
        console.warn(`[bot] cannot send room panel in voice chat ${channel.id}`, error);
      }
      await store.updateRoom(channel.id, { controlMessageId });
      this.roomGrace.delete(channel.id);
      // Người dùng có thể đã thoát ngay lập tức: kiểm tra lại lần cuối.
      await this.removeRoomIfEmpty(channel.id, 'Host rời ngay sau khi tạo phòng');
    } catch (error) {
      console.error(`[bot] cannot create room for ${member.user.tag} in ${member.guild.id}`, error);
      await member.send(`Không tạo được phòng trong **${member.guild.name}**: ${error instanceof Error ? error.message : 'Lỗi không xác định'}`).catch(() => undefined);
      if (member.voice.channelId === creator.channelId) {
        if (previousChannelId) await member.voice.setChannel(previousChannelId, 'Hoàn tác vì tạo phòng lỗi').catch(() => undefined);
        else await member.voice.disconnect('Tạo phòng thất bại').catch(() => undefined);
      }
    } finally {
      this.creatingOwners.delete(key);
      if (cache.backend !== 'memory') await cache.del(distributedLockKey);
    }
  }

  private async enforceRoomPassword(member: GuildMember, room: Room): Promise<boolean> {
    if (!room.passwordHash || member.id === room.ownerId || member.permissions.has(PermissionFlagsBits.Administrator) || await store.hasRoomAccess(room.id, member.id)) return true;
    this.rejectedPasswordLeaves.add(`${room.channelId}:${member.id}`);
    await member.voice.disconnect('Phòng voice yêu cầu mật khẩu').catch(() => undefined);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`roompass:enter:${room.channelId}`).setLabel('Nhập mật khẩu').setStyle(ButtonStyle.Primary));
    await member.send({
      embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle('Phòng voice có mật khẩu').setDescription(`Phòng <#${room.channelId}> trong **${member.guild.name}** yêu cầu mật khẩu. Nhấn nút bên dưới, nhập đúng rồi vào lại phòng.`)],
      components: [row],
    }).catch(() => undefined);
    return false;
  }

  private async runMaintenance(): Promise<void> {
    for (const [key, attempt] of this.passwordAttempts) if (attempt.resetAt <= Date.now()) this.passwordAttempts.delete(key);
    await this.sendExpiryReminders();
    await this.expireDueEntitlements();
  }

  private async sendExpiryReminders(): Promise<void> {
    for (const entitlement of await store.listEntitlementsNeedingReminder(3)) {
      const guild = this.client.guilds.cache.get(entitlement.guildId);
      const user = await this.client.users.fetch(entitlement.discordUserId).catch(() => null);
      if (user) {
        const product = await store.getProduct(entitlement.productId);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('Gia hạn Premium').setStyle(ButtonStyle.Link).setURL(config.publicUrl));
        await user.send({
          embeds: [new EmbedBuilder()
            .setColor(0xf59e0b)
            .setTitle('Premium sắp hết hạn')
            .setDescription(`Gói **${product?.name || 'Premium'}** tại **${guild?.name || 'server Discord'}** sẽ hết hạn vào **${new Date(entitlement.expiresAt).toLocaleString('vi-VN')}**.\n\nGia hạn ngay sẽ cộng tiếp thời gian từ ngày hết hạn hiện tại.`)
            .setFooter({ text: 'Nếu không gia hạn, bot chỉ giữ phòng editable đầu tiên của bạn.' })],
          components: [row],
        }).catch(() => undefined);
      }
      await store.markEntitlementReminder(entitlement.id);
    }
  }

  private async expireDueEntitlements(): Promise<void> {
    const due = await store.expireDueEntitlements();
    const downgraded = new Set<string>();
    for (const entitlement of due) {
      const guild = this.client.guilds.cache.get(entitlement.guildId);
      if (!guild) continue;
      const member = await guild.members.fetch(entitlement.discordUserId).catch(() => null);
      if (member && entitlement.roleId && !await store.hasActiveEntitlementForRole(entitlement.guildId, entitlement.discordUserId, entitlement.roleId)) {
        await member.roles.remove(entitlement.roleId, 'SGF Premium entitlement expired').catch(() => undefined);
      }
      const key = `${entitlement.guildId}:${entitlement.discordUserId}`;
      if (downgraded.has(key) || await store.hasActiveEntitlement(entitlement.guildId, entitlement.discordUserId)) continue;
      downgraded.add(key);
      const editableRooms = (await store.listRoomsByOwner(entitlement.guildId, entitlement.discordUserId)).filter((room) => room.mode === 'editable');
      const activeEditableRooms: Array<{ room: Room; channel: VoiceBasedChannel }> = [];
      for (const room of editableRooms) {
        const roomChannel = await this.resolveOrForgetRoom(room);
        if (roomChannel) activeEditableRooms.push({ room, channel: roomChannel });
      }
      const removed: string[] = [];
      for (const { room, channel } of activeEditableRooms.slice(1)) {
        await store.deleteRoomByChannel(room.channelId);
        this.roomGrace.delete(room.channelId);
        await channel.delete('Premium hết hạn: giữ phòng editable đầu tiên').catch(() => undefined);
        removed.push(room.channelId);
      }
      if (member) {
        await member.send(`Premium tại **${guild.name}** đã hết hạn.${removed.length ? ` Bot đã đóng ${removed.length} phòng editable vượt giới hạn Free và giữ lại phòng đầu tiên.` : ' Bạn vẫn được dùng 1 phòng editable theo gói Free.'}`).catch(() => undefined);
      }
    }
  }

  private async isPremium(member: GuildMember, _settings: GuildSettings): Promise<boolean> {
    if (isDeveloperUser(member.id)) return true;
    return store.hasActiveEntitlement(member.guild.id, member.id);
  }

  private async canReceiveOwnership(room: Room, member: GuildMember): Promise<boolean> {
    if (room.mode !== 'editable' || isDeveloperUser(member.id) || await store.hasActiveEntitlement(member.guild.id, member.id)) return true;
    const ownedRooms = await store.listRoomsByOwner(member.guild.id, member.id);
    for (const ownedRoom of ownedRooms) {
      if (ownedRoom.mode !== 'editable' || ownedRoom.channelId === room.channelId) continue;
      if (await this.resolveOrForgetRoom(ownedRoom)) return false;
    }
    return true;
  }

  /**
   * Host rời phòng: giao host tạm cho người còn lại để phòng không bị "mồ côi".
   * Host gốc vẫn được nhớ trong originalOwnerId và sẽ được trả lại khi họ quay về.
   */
  private async autoTransferOwnership(room: Room): Promise<void> {
    const guild = this.client.guilds.cache.get(room.guildId);
    if (!guild) return;
    const channel = await this.fetchVoiceChannel(room.guildId, room.channelId);
    if (!channel) return;
    const creator = (await store.getSettings(room.guildId)).creatorChannels.find((item) => item.channelId === room.creatorChannelId);
    if (creator?.autoTransferOwner === false) return;

    const candidates = humanMembers(channel).filter((candidate) => candidate.id !== room.ownerId);
    if (!candidates.length) return;

    // Ưu tiên người đủ điều kiện theo giới hạn gói Free.
    let nextHost: GuildMember | undefined;
    for (const candidate of candidates) {
      if (await this.canReceiveOwnership(room, candidate)) {
        nextHost = candidate;
        break;
      }
    }
    // Không ai "đủ điều kiện" thì vẫn phải giao host cho ai đó, nếu không phòng sẽ
    // kẹt vĩnh viễn với panel không ai bấm được. Đây là host tạm, không phải host gốc.
    const provisional = !nextHost;
    if (!nextHost) nextHost = candidates[0];

    try {
      await this.transferOwnership(
        room,
        nextHost,
        provisional
          ? 'Host cũ đã rời phòng nên bot giao host tạm. Host gốc quay lại sẽ tự nhận lại quyền.'
          : 'Host cũ đã rời phòng.',
        { skipLimitCheck: true, keepOriginalOwner: true },
      );
    } catch (error) {
      console.warn(`[bot] không tự chuyển được host cho phòng ${room.channelId}`, error);
    }
  }

  private async transferOwnership(
    room: Room,
    nextHost: GuildMember,
    reason: string,
    options: { skipLimitCheck?: boolean; keepOriginalOwner?: boolean } = {},
  ): Promise<Room> {
    const channel = await this.fetchVoiceChannel(room.guildId, room.channelId);
    if (!channel) throw new Error('Phòng không còn tồn tại.');
    if (!options.skipLimitCheck && !await this.canReceiveOwnership(room, nextHost)) {
      throw new Error('Member này đã có 1 phòng editable theo giới hạn Free. Hãy chọn member Premium hoặc đóng phòng cũ trước.');
    }
    const oldOwnerId = room.ownerId;
    const originalOwnerId = room.originalOwnerId || room.ownerId;
    // Không được thu quyền của host gốc, nếu không họ sẽ không vào lại được phòng bị khóa/ẩn.
    if (oldOwnerId !== nextHost.id && oldOwnerId !== originalOwnerId) {
      await channel.permissionOverwrites.edit(oldOwnerId, { ViewChannel: null, Connect: null, Speak: null }).catch(() => undefined);
    }
    await channel.permissionOverwrites.edit(nextHost.id, { ViewChannel: true, Connect: true, Speak: true }).catch(() => undefined);
    // Host gốc luôn giữ quyền vào lại phòng.
    if (originalOwnerId !== nextHost.id) {
      await channel.permissionOverwrites.edit(originalOwnerId, { ViewChannel: true, Connect: true }).catch(() => undefined);
    }
    const updated = (await store.updateRoom(room.channelId, {
      ownerId: nextHost.id,
      ownerTag: nextHost.user.tag,
      // Chuyển host thủ công = đổi luôn host gốc. Chuyển tự động = giữ host gốc để trả lại sau.
      ...(options.keepOriginalOwner ? {} : { originalOwnerId: nextHost.id }),
    }))!;
    await this.sendRoomNotice(updated, `👑 <@${nextHost.id}> đã trở thành **host**. ${reason}`);
    await this.refreshRoomPanel(updated);
    return updated;
  }

  /**
   * Xóa phòng khi không còn người thật nào (bot ở lại không tính).
   * Luôn lấy channel trực tiếp từ API khi cache thiếu, vì cache rỗng từng khiến
   * bot tưởng phòng đã biến mất và bỏ luôn việc xóa kênh thật.
   */
  private async removeRoomIfEmpty(channelId: string, reason = 'Phòng tạm đã trống'): Promise<boolean> {
    if (this.roomLocks.has(channelId)) return false;
    this.roomLocks.add(channelId);
    try {
      const room = await store.getRoomByChannel(channelId);
      if (!room) return false;

      // Guild đang unavailable (outage/chưa kịp cache): tuyệt đối không dọn record,
      // nếu không sẽ mất dấu những phòng vẫn đang sống.
      const guild = this.client.guilds.cache.get(room.guildId);
      if (!guild) return false;

      const { channel, gone } = await this.resolveRoomChannel(room.guildId, channelId);
      if (gone) {
        // Kênh đã bị xóa ở phía Discord: chỉ cần dọn record.
        await store.deleteRoomByChannel(channelId);
        this.roomGrace.delete(channelId);
        return true;
      }
      // Không phân giải được (mạng/rate limit): giữ record, chu kỳ sweep sau sẽ thử lại.
      if (!channel) return false;

      const graceUntil = this.roomGrace.get(channelId) || 0;
      const humans = humanMembers(channel);
      if (humans.length > 0) {
        this.roomGrace.delete(channelId);
        return false;
      }
      // Phòng vừa tạo còn đang chờ bot move host vào, chưa xóa vội.
      if (graceUntil > Date.now()) return false;

      await store.deleteRoomByChannel(channelId);
      this.roomGrace.delete(channelId);
      await channel.delete(reason).catch((error) => {
        if (SgfBot.interactionErrorCode(error) === 10003) return; // Unknown Channel: đã bị xóa rồi.
        console.error(`[bot] không xóa được voice channel ${channelId}`, error);
      });
      return true;
    } finally {
      this.roomLocks.delete(channelId);
    }
  }

  /** Lấy voice channel từ cache, fallback sang REST khi cache chưa có/đã bị dọn. */
  private async fetchVoiceChannel(guildId: string, channelId: string): Promise<VoiceBasedChannel | undefined> {
    return (await this.resolveRoomChannel(guildId, channelId)).channel;
  }

  /**
   * Phân giải channel của một phòng một cách chắc chắn.
   *
   * Rất quan trọng: chỉ báo `gone = true` khi Discord thực sự trả về 10003 (Unknown Channel).
   * Cache miss, mất mạng hay rate limit KHÔNG được coi là "kênh đã bị xóa" - nếu nhầm,
   * bot sẽ xóa record DB trong khi kênh voice thật vẫn còn, tạo ra kênh rác vĩnh viễn
   * mà không còn ai theo dõi để dọn.
   */
  private async resolveRoomChannel(guildId: string, channelId: string): Promise<{ channel?: VoiceBasedChannel; gone: boolean }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return { gone: false };
    const cached = guild.channels.cache.get(channelId);
    if (cached) return cached.isVoiceBased() ? { channel: cached, gone: false } : { gone: true };
    try {
      const fetched = await guild.channels.fetch(channelId);
      if (!fetched) return { gone: true };
      return fetched.isVoiceBased() ? { channel: fetched, gone: false } : { gone: true };
    } catch (error) {
      // 10003 = Unknown Channel: kênh đã bị xóa thật.
      if (SgfBot.interactionErrorCode(error) === 10003) return { gone: true };
      console.warn(`[bot] không phân giải được kênh ${channelId}, giữ nguyên record để thử lại sau`, error);
      return { gone: false };
    }
  }

  /** Chỉ xóa record khi chắc chắn kênh đã biến mất. Trả về channel nếu còn sống. */
  private async resolveOrForgetRoom(room: Room): Promise<VoiceBasedChannel | undefined> {
    const { channel, gone } = await this.resolveRoomChannel(room.guildId, room.channelId);
    if (gone) {
      await store.deleteRoomByChannel(room.channelId);
      this.roomGrace.delete(room.channelId);
    }
    return channel;
  }

  /**
   * Quét toàn bộ phòng đã lưu và dọn những phòng không còn người thật.
   * Chạy định kỳ nên dù bot bỏ lỡ event nào (restart, mất mạng, gateway lag)
   * thì phòng trống vẫn luôn được xóa trong vòng một chu kỳ.
   */
  private async sweepRooms(trigger: 'startup' | 'interval' | 'resume'): Promise<void> {
    if (!this.client.isReady() || this.sweeping) return;
    this.sweeping = true;
    try {
      const rooms = typeof (store as { listAllRooms?: unknown }).listAllRooms === 'function'
        ? await (store as unknown as { listAllRooms(): Promise<Room[]> }).listAllRooms()
        : (await Promise.all([...this.client.guilds.cache.keys()].map((guildId) => store.listRooms(guildId)))).flat();
      let removed = 0;
      for (const room of rooms) {
        // Bỏ qua guild mà instance này không phục vụ (sharding).
        if (!this.client.guilds.cache.has(room.guildId)) continue;
        if (await this.removeRoomIfEmpty(room.channelId, 'Phòng tạm không còn người thật')) removed += 1;
      }
      if (removed) console.log(`[bot] sweep (${trigger}) đã dọn ${removed} phòng trống.`);
    } catch (error) {
      console.error(`[bot] sweep (${trigger}) lỗi`, error);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Ping DB và Redis định kỳ. Kết nối "nguội" là lý do phổ biến nhất khiến lần
   * bấm nút đầu tiên sau vài phút im ắng vượt quá 3 giây và hiện "didn't respond in time".
   */
  private async keepConnectionsWarm(): Promise<void> {
    try {
      await Promise.allSettled([
        store.getStats(this.client.guilds.cache.firstKey() || '0'),
        cache.ping(),
      ]);
    } catch {
      // Ping thất bại không phải lỗi nghiêm trọng.
    }
  }

  private roomButtonRows(room: Room): ActionRowBuilder<ButtonBuilder>[] {
    const disabled = room.mode !== 'editable';
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`room:rename:${room.channelId}`).setLabel('Đổi tên').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:limit:${room.channelId}`).setLabel('Limit').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:lock:${room.channelId}`).setLabel('Khóa/mở').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:hide:${room.channelId}`).setLabel('Ẩn/hiện').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:password:${room.channelId}`).setLabel('Mật khẩu').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`room:invite:${room.channelId}`).setLabel('Mời').setStyle(ButtonStyle.Primary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:kick:${room.channelId}`).setLabel('Kick').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:transfer:${room.channelId}`).setLabel('Chuyển host').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:notify:${room.channelId}`).setLabel('Log ra/vào').setStyle(room.notifyJoinLeave ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`room:delete:${room.channelId}`).setLabel('Xóa').setStyle(ButtonStyle.Danger),
      ),
    ];
  }

  private roomPanelEmbed(room: Room): EmbedBuilder {
    const editable = room.mode === 'editable';
    const originalOwnerId = room.originalOwnerId || room.ownerId;
    const hostLine = originalOwnerId !== room.ownerId
      ? `Host hiện tại: <@${room.ownerId}> (tạm)\nHost gốc: <@${originalOwnerId}> - tự nhận lại quyền khi quay lại phòng`
      : `Host: <@${room.ownerId}>`;
    return new EmbedBuilder()
      .setColor(editable ? 0x5865f2 : 0x64748b)
      .setTitle(editable ? 'Bảng điều khiển phòng' : 'Phòng cơ bản')
      .setDescription(`${hostLine}\nChế độ: **${editable ? 'Editable' : 'Không chỉnh sửa'}**\nMật khẩu: **${room.passwordHash ? 'Đang bật' : 'Tắt'}**\nThông báo ra/vào: **${room.notifyJoinLeave ? 'Bật' : 'Tắt'}**\n\n${editable ? 'Chỉ host hiện tại hoặc admin server có thể dùng các nút.' : 'Phòng cơ bản chỉ có thể xóa. Hãy dùng creator editable để mở toàn bộ control.'}`)
      .setFooter({ text: 'Panel dùng được vô thời hạn. Phòng tự xóa khi người thật cuối cùng rời đi' });
  }

  private async sendRoomControlPanel(guild: Guild, room: Room): Promise<string> {
    const channel = await this.fetchVoiceChannel(guild.id, room.channelId);
    if (!channel?.isTextBased()) return '';
    const message = await channel.send({ embeds: [this.roomPanelEmbed(room)], components: this.roomButtonRows(room) });
    return message.id;
  }

  /** Cập nhật panel. Nếu message gốc bị xóa thì đăng lại panel mới. */
  private async refreshRoomPanel(room: Room): Promise<void> {
    const guild = this.client.guilds.cache.get(room.guildId);
    if (!guild) return;
    const channel = await this.fetchVoiceChannel(room.guildId, room.channelId);
    if (!channel?.isTextBased()) return;
    if (room.controlMessageId) {
      const message = await channel.messages.fetch(room.controlMessageId).catch(() => null);
      if (message) {
        await message.edit({ embeds: [this.roomPanelEmbed(room)], components: this.roomButtonRows(room) }).catch(() => undefined);
        return;
      }
    }
    // Panel biến mất (bị xóa tay hoặc mất khi bot offline): dựng lại để phòng luôn điều khiển được.
    const controlMessageId = await this.sendRoomControlPanel(guild, room).catch(() => '');
    if (controlMessageId) await store.updateRoom(room.channelId, { controlMessageId });
  }

  private async sendRoomNotice(room: Room, content: string): Promise<void> {
    const channel = await this.fetchVoiceChannel(room.guildId, room.channelId);
    if (channel?.isTextBased()) await channel.send({ content, allowedMentions: { users: [] } }).catch(() => undefined);
  }

  private paymentButtonRow(products: Product[]): ActionRowBuilder<ButtonBuilder> | undefined {
    if (!products.length) return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('pay:donate:x').setLabel('Donate').setStyle(ButtonStyle.Success));
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const product of products.slice(0, 4)) row.addComponents(new ButtonBuilder().setCustomId(`pay:buy:${product.id}`).setLabel(`${product.name} - ${formatVnd(product.priceVnd)}`).setStyle(ButtonStyle.Primary));
    row.addComponents(new ButtonBuilder().setCustomId('pay:donate:x').setLabel('Donate').setStyle(ButtonStyle.Success));
    return row;
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const [namespace, action, value] = interaction.customId.split(':');
    if (namespace === 'room') return this.onRoomButton(interaction, action, value);
    if (namespace === 'roompass' && action === 'enter') {
      const modal = new ModalBuilder().setCustomId(`roompassmodal:verify:${value}`).setTitle('Nhập mật khẩu phòng');
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('password').setLabel('Mật khẩu').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)));
      await interaction.showModal(modal);
      return;
    }
    if (namespace === 'pay') return this.onPaymentButton(interaction, action, value);
  }

  private async onRoomButton(interaction: ButtonInteraction, action: string, channelId: string): Promise<void> {
    if (!interaction.guild) {
      await this.respond(interaction, { content: 'Hãy dùng panel này trong server Discord.' });
      return;
    }
    // Modal phải được show trước khi ack bất cứ thứ gì khác, và phải xảy ra
    // trong 3 giây đầu - nên không được await DB trước bước này.
    // Chỉ dùng cache ở đây: showModal bắt buộc phải xảy ra trong 3 giây nên không được
    // await REST trước. Cache miss sẽ rơi xuống nhánh ackDefer bên dưới để xử lý an toàn.
    const cachedChannel = interaction.guild.channels.cache.get(channelId);
    const channel = cachedChannel?.isVoiceBased() ? cachedChannel : undefined;
    if (cachedChannel && !channel) {
      await this.respond(interaction, { content: 'Kênh của panel này đã bị xóa.' });
      void store.deleteRoomByChannel(channelId);
      return;
    }

    if (action === 'rename' || action === 'limit' || action === 'password') {
      const titles = { rename: 'Đổi tên phòng', limit: 'Giới hạn thành viên', password: 'Mật khẩu phòng' } as const;
      const modal = new ModalBuilder().setCustomId(`roommodal:${action}:${channelId}`).setTitle(titles[action]);
      const input = action === 'rename'
        // Giá trị prefill lấy từ cache. showModal phải chạy trong 3 giây nên không được
        // await REST ở đây; nếu cache thiếu thì để trống, việc xác thực làm sau khi submit.
        ? new TextInputBuilder().setCustomId('name').setLabel('Tên mới').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(channel?.name || '')
        : action === 'limit'
          ? new TextInputBuilder().setCustomId('limit').setLabel('0 để bỏ giới hạn, tối đa 99').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(channel?.userLimit || 0))
          : new TextInputBuilder().setCustomId('password').setLabel('Để trống để tắt mật khẩu').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(64);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal).catch((error) => {
        if (!SgfBot.isDeadInteraction(error)) throw error;
        this.deadInteractionCount += 1;
      });
      return;
    }
    if (['invite', 'kick', 'transfer'].includes(action)) {
      const labels: Record<string, string> = { invite: 'Chọn người muốn mời', kick: 'Chọn người muốn kick', transfer: 'Chọn host mới' };
      const select = new UserSelectMenuBuilder().setCustomId(`roomuser:${action}:${channelId}`).setPlaceholder(labels[action]).setMinValues(1).setMaxValues(1);
      await interaction.reply({
        content: labels[action],
        components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
        flags: MessageFlags.Ephemeral,
      }).catch((error) => {
        if (!SgfBot.isDeadInteraction(error)) throw error;
        this.deadInteractionCount += 1;
      });
      return;
    }

    // Ack TRƯỚC khi chạm DB. Mọi truy vấn sau đây đều nằm trong cửa sổ 15 phút của token.
    if (!await this.ackDefer(interaction)) return;
    const room = await store.getRoomByChannel(channelId);
    if (!room) {
      await this.respond(interaction, { content: 'Phòng này không còn tồn tại.' });
      return;
    }
    // Giờ đã ack xong nên thoải mái gọi REST để chắc chắn có channel thật.
    const liveChannel = channel || await this.resolveOrForgetRoom(room);
    if (!liveChannel) {
      await this.respond(interaction, { content: 'Phòng này không còn tồn tại.' });
      return;
    }
    if (interaction.user.id !== room.ownerId && !isAdmin(interaction)) {
      await this.respond(interaction, { content: `Chỉ host hiện tại (<@${room.ownerId}>) hoặc admin mới dùng được bảng này.` });
      return;
    }
    if (action !== 'delete' && room.mode !== 'editable') {
      await this.respond(interaction, { content: 'Creator của phòng này được đặt ở chế độ không chỉnh sửa.' });
      return;
    }
    if (action === 'lock') {
      const everyone = interaction.guild.roles.everyone;
      const locked = liveChannel.permissionOverwrites.cache.get(everyone.id)?.deny.has(PermissionFlagsBits.Connect);
      await liveChannel.permissionOverwrites.edit(everyone, { Connect: locked ? null : false });
      await liveChannel.permissionOverwrites.edit(room.ownerId, { Connect: true, ViewChannel: true });
      if (room.originalOwnerId && room.originalOwnerId !== room.ownerId) await liveChannel.permissionOverwrites.edit(room.originalOwnerId, { Connect: true, ViewChannel: true }).catch(() => undefined);
      await this.respond(interaction, { content: locked ? '🔓 Đã mở khóa phòng.' : '🔒 Đã khóa phòng với người ngoài.' });
      return;
    }
    if (action === 'hide') {
      const everyone = interaction.guild.roles.everyone;
      const hidden = liveChannel.permissionOverwrites.cache.get(everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel);
      await liveChannel.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false });
      await liveChannel.permissionOverwrites.edit(room.ownerId, { ViewChannel: true, Connect: true });
      if (room.originalOwnerId && room.originalOwnerId !== room.ownerId) await liveChannel.permissionOverwrites.edit(room.originalOwnerId, { ViewChannel: true, Connect: true }).catch(() => undefined);
      await this.respond(interaction, { content: hidden ? '👁️ Đã hiện phòng.' : '🙈 Đã ẩn phòng khỏi thành viên khác.' });
      return;
    }
    if (action === 'notify') {
      const updated = (await store.updateRoom(channelId, { notifyJoinLeave: !room.notifyJoinLeave }))!;
      await this.refreshRoomPanel(updated);
      await this.respond(interaction, { content: `🔔 Thông báo người ra/vào đã **${updated.notifyJoinLeave ? 'bật' : 'tắt'}**.` });
      return;
    }
    if (action === 'delete') {
      this.roomGrace.delete(channelId);
      await store.deleteRoomByChannel(channelId);
      // Trả lời trước khi xóa kênh: xóa kênh cũng xóa luôn chat chứa panel.
      await this.respond(interaction, { content: '🗑️ Đã xóa phòng.' });
      await liveChannel.delete('Host/admin xóa phòng tạm').catch(() => undefined);
    }
  }

  private async onUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    const [namespace, action, channelId] = interaction.customId.split(':');
    if (namespace !== 'roomuser' || !interaction.guild) return;
    if (!await this.ackDefer(interaction)) return;
    const room = await store.getRoomByChannel(channelId);
    if (!room || (interaction.user.id !== room.ownerId && !isAdmin(interaction))) {
      await this.respond(interaction, { content: 'Bạn không còn quyền điều khiển phòng này.' });
      return;
    }
    const targetId = interaction.values[0];
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    const channel = await this.fetchVoiceChannel(room.guildId, channelId);
    if (!target || !channel) {
      await this.respond(interaction, { content: 'Không tìm thấy member hoặc phòng.' });
      return;
    }
    if (action === 'invite') {
      await store.grantRoomAccess(room.id, target.id);
      await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true });
      await this.respond(interaction, { content: `✅ Đã mời <@${target.id}> vào phòng.` });
      return;
    }
    if (target.voice.channelId !== channelId) {
      await this.respond(interaction, { content: 'Member được chọn hiện không ở trong phòng.' });
      return;
    }
    if (target.id === room.ownerId) {
      await this.respond(interaction, { content: 'Không thể kick hoặc chuyển host cho chính host hiện tại.' });
      return;
    }
    if (action === 'kick') {
      await store.revokeRoomAccess(room.id, target.id);
      await channel.permissionOverwrites.delete(target.id, 'Thu hồi quyền khi bị kick').catch(() => undefined);
      await target.voice.disconnect(`Bị kick khỏi phòng bởi ${interaction.user.tag}`).catch(() => undefined);
      await this.respond(interaction, { content: `👢 Đã kick <@${target.id}> và thu hồi quyền mời/password.` });
      await this.removeRoomIfEmpty(channelId, 'Phòng trống sau khi kick');
      return;
    }
    if (action === 'transfer') {
      try {
        // Chuyển host thủ công là cố ý, nên host gốc cũng đổi theo.
        await this.transferOwnership(room, target, `Chuyển bởi <@${interaction.user.id}>.`);
        await this.respond(interaction, { content: `👑 Đã chuyển host cho <@${target.id}>.` });
      } catch (error) {
        await this.respond(interaction, { content: error instanceof Error ? error.message : 'Không chuyển được host.' });
      }
    }
  }

  private async onModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [namespace, action, channelId] = interaction.customId.split(':');
    if (namespace === 'payment') return this.onDonationModal(interaction);
    if (namespace === 'roompassmodal' && action === 'verify') {
      if (!await this.ackDefer(interaction, Boolean(interaction.guild))) return;
      const room = await store.getRoomByChannel(channelId);
      const attemptKey = `${channelId}:${interaction.user.id}`;
      const redisAttemptKey = `password-attempt:${attemptKey}`;
      const memoryAttempt = this.passwordAttempts.get(attemptKey);
      const attemptCount = cache.backend === 'memory' ? memoryAttempt?.count || 0 : Number(await cache.get(redisAttemptKey) || 0);
      if (attemptCount >= 5) {
        await this.respond(interaction, { content: '⏳ Bạn đã nhập sai quá nhiều lần. Hãy thử lại sau 5 phút.' });
        return;
      }
      const password = interaction.fields.getTextInputValue('password');
      if (!room || !await passwordMatches(password, room)) {
        const nextCount = cache.backend === 'memory'
          ? attemptCount + 1
          : await cache.increment(redisAttemptKey, 5 * 60);
        if (cache.backend === 'memory') this.passwordAttempts.set(attemptKey, { count: nextCount, resetAt: Date.now() + 5 * 60_000 });
        await this.respond(interaction, { content: `❌ Mật khẩu không đúng hoặc phòng đã bị xóa. Còn ${Math.max(0, 5 - nextCount)} lần thử trước khi tạm khóa.` });
        return;
      }
      this.passwordAttempts.delete(attemptKey);
      if (cache.backend !== 'memory') await cache.del(redisAttemptKey);
      await store.grantRoomAccess(room.id, interaction.user.id);
      await this.respond(interaction, { content: `✅ Đúng mật khẩu. Bạn có thể vào lại phòng <#${room.channelId}>.` });
      return;
    }
    if (namespace !== 'roommodal' || !interaction.guild) return;
    if (!await this.ackDefer(interaction)) return;
    const room = await store.getRoomByChannel(channelId);
    const channel = await this.fetchVoiceChannel(interaction.guild.id, channelId);
    if (!room || !channel) {
      await this.respond(interaction, { content: 'Phòng không còn tồn tại.' });
      return;
    }
    if (interaction.user.id !== room.ownerId && !isAdmin(interaction)) {
      await this.respond(interaction, { content: `Chỉ host hiện tại (<@${room.ownerId}>) hoặc admin mới thao tác được.` });
      return;
    }
    if (action === 'rename') {
      const name = interaction.fields.getTextInputValue('name').trim().slice(0, 100);
      // setName bị rate limit rất gắt (2 lần / 10 phút / kênh) nên phải báo lỗi rõ ràng.
      try {
        await channel.setName(name, 'Đổi tên bởi host');
        await this.respond(interaction, { content: `✏️ Đã đổi tên thành **${name}**.` });
      } catch (error) {
        await this.respond(interaction, { content: 'Discord đang giới hạn đổi tên kênh (tối đa 2 lần mỗi 10 phút cho một kênh). Thử lại sau ít phút nhé.' });
        console.warn('[bot] rename bị chặn', error);
      }
      return;
    }
    if (action === 'limit') {
      const raw = Number(interaction.fields.getTextInputValue('limit'));
      const limit = Number.isFinite(raw) ? Math.min(99, Math.max(0, Math.round(raw))) : -1;
      if (limit < 0) {
        await this.respond(interaction, { content: 'Nhập số từ 0 đến 99.' });
        return;
      }
      await channel.setUserLimit(limit, 'Đổi giới hạn bởi host');
      await this.respond(interaction, { content: `👥 Đã đặt giới hạn: **${limit === 0 ? 'Không giới hạn' : limit}**.` });
      return;
    }
    if (action === 'password') {
      const password = interaction.fields.getTextInputValue('password').trim();
      await store.clearRoomAccess(room.id);
      const salt = password ? crypto.randomBytes(16).toString('hex') : '';
      const updated = (await store.updateRoom(channelId, {
        passwordSalt: salt,
        passwordHash: password ? await passwordDigest(password, salt) : '',
      }))!;
      await this.refreshRoomPanel(updated);
      await this.respond(interaction, { content: password ? '🔐 Đã bật/đổi mật khẩu phòng.' : '🔓 Đã tắt mật khẩu phòng.' });
    }
  }

  private donationModal(): ModalBuilder {
    const modal = new ModalBuilder().setCustomId('payment:donate').setTitle('Donate cho SGF');
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Số tiền VND, ví dụ 50000').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('note').setLabel('Lời nhắn (không bắt buộc)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200)),
    );
    return modal;
  }

  private async onPaymentButton(interaction: ButtonInteraction, action: string, productId?: string): Promise<void> {
    if (!interaction.guild) return;
    if (action === 'donate') return interaction.showModal(this.donationModal());
    if (action !== 'buy' || !productId) return;
    if (!await this.ackDefer(interaction)) return;
    try {
      const result = await createProductPayment({ guildId: interaction.guild.id, userId: interaction.user.id, userTag: interaction.user.tag, productId });
      await interaction.editReply(this.paymentMessage(result));
    } catch (error) {
      await this.respond(interaction, { content: error instanceof Error ? error.message : 'Không tạo được đơn thanh toán.' });
    }
  }

  private async onDonationModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.guild) return;
    if (!await this.ackDefer(interaction)) return;
    const amount = Number(interaction.fields.getTextInputValue('amount').replace(/[^0-9]/g, ''));
    const note = interaction.fields.getTextInputValue('note').trim();
    try {
      const result = await createDonationPayment({ guildId: interaction.guild.id, userId: interaction.user.id, userTag: interaction.user.tag, amountVnd: amount, note });
      await interaction.editReply(this.paymentMessage(result));
    } catch (error) {
      await this.respond(interaction, { content: error instanceof Error ? error.message : 'Không tạo được đơn donate.' });
    }
  }

  private paymentMessage(result: PaymentCreationResult): { content: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const { payment, product, qrDynamic, bankCode, bankName, accountNumber, accountName } = result;
    const lines = [
      `**${product?.name || 'Donate cho SGF'}**`,
      `Số tiền: **${formatVnd(payment.expectedAmountVnd)}**`,
      `Nội dung chuyển khoản: **${payment.orderCode}**`,
      bankCode ? `Ngân hàng: **${bankName || bankCode}${bankName && bankName !== bankCode ? ` (${bankCode})` : ''}**` : '',
      accountNumber ? `STK: **${accountNumber}**` : '',
      accountName ? `Tên TK: **${accountName}**` : '',
      qrDynamic ? 'QR đã điền sẵn số tiền + mã đơn.' : 'QR tĩnh: hãy tự nhập đúng số tiền và nội dung chuyển khoản.',
      product ? 'Gia hạn Premium khi còn hạn sẽ cộng tiếp từ ngày hết hạn hiện tại.' : 'Webhook SePay sẽ tự xác nhận giao dịch.',
    ].filter(Boolean).join('\n');
    const embed = new EmbedBuilder().setColor(0x2dd4bf).setTitle('Đơn thanh toán SGF').setDescription(lines).setFooter({ text: `Mã đơn ${payment.orderCode}` });
    if (payment.qrUrl) embed.setImage(payment.qrUrl);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('Mở trang thanh toán').setStyle(ButtonStyle.Link).setURL(payment.checkoutUrl));
    return { content: 'Đây là tin nhắn riêng chỉ bạn nhìn thấy.', embeds: [embed], components: [row] };
  }

  async manageManualPremium(input: { guildId: string; userId: string; action: 'grant' | 'extend' | 'revoke'; days: number; developerId: string; note?: string }) {
    if (!isDeveloperUser(input.developerId)) throw new Error('Chỉ Study Voice developers được quản lý Premium thủ công.');
    const guild = this.client.guilds.cache.get(input.guildId);
    if (!guild) throw new Error('Bot chưa kết nối server này.');
    const member = await guild.members.fetch(input.userId).catch(() => null);
    if (!member) throw new Error('Không tìm thấy member trong server.');
    const settings = await store.getSettings(input.guildId, guild.name);
    const roleId = settings.premiumRoleId;

    if (input.action === 'revoke') {
      await store.revokeUserEntitlements(input.guildId, input.userId, input.developerId);
      if (roleId && !isDeveloperUser(input.userId)) await member.roles.remove(roleId, `Premium revoked by developer ${input.developerId}`).catch(() => undefined);
      return { action: 'revoke', founder: isDeveloperUser(input.userId), entitlement: undefined, message: isDeveloperUser(input.userId) ? 'Đã thu hồi entitlement, nhưng tài khoản founder vẫn luôn có đặc quyền Premium.' : 'Đã thu hồi Premium.' };
    }

    const entitlement = await store.grantManualEntitlement({
      guildId: input.guildId,
      discordUserId: input.userId,
      roleId,
      days: Math.max(0, Math.round(input.days)),
      extend: input.action === 'extend',
      grantedBy: input.developerId,
      note: input.note || `Manual ${input.action} by Study Voice developer`,
    });
    if (roleId) await member.roles.add(roleId, `Premium ${input.action} by developer ${input.developerId}`).catch(() => undefined);
    return { action: input.action, founder: isDeveloperUser(input.userId), entitlement, message: entitlement.expiresAt ? `Premium có hiệu lực đến ${new Date(entitlement.expiresAt).toLocaleString('vi-VN')}.` : 'Đã cấp Premium không thời hạn.' };
  }

  listConnectedGuilds(): Array<{ id: string; name: string; icon: string; memberCount: number }> {
    return [...this.client.guilds.cache.values()].map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon || '',
      memberCount: guild.memberCount,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listGuildMembers(guildId: string, force = false): Promise<GuildMemberView[]> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Bot chưa ở trong server.');
    let snapshot = this.guildMemberSnapshots.get(guildId);
    if (!force && snapshot && snapshot.expiresAt > Date.now()) return snapshot.data;
    if (!force && cache.backend !== 'memory') {
      const cachedMembers = await cache.getJson<GuildMemberView[]>(`guild-members:${guildId}`);
      if (cachedMembers) {
        snapshot = { expiresAt: Date.now() + 5 * 60_000, data: cachedMembers };
        this.guildMemberSnapshots.set(guildId, snapshot);
        return cachedMembers;
      }
    }
    const retryAt = this.guildMemberRetryAt.get(guildId) || 0;
    if (retryAt > Date.now() && !snapshot) throw new Error(`Discord đang giới hạn member fetch. Thử lại sau ${Math.ceil((retryAt - Date.now()) / 1000)} giây.`);
    const running = this.guildMemberFetches.get(guildId);
    if (running) return running;

    const task = (async () => {
      try {
        const members = await guild.members.fetch();
        const data = [...members.values()].map((member) => ({
          id: member.id,
          username: member.user.username,
          globalName: member.user.globalName || '',
          displayName: member.displayName,
          avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 64 }),
          bot: member.user.bot,
          joinedAt: member.joinedAt?.toISOString() || '',
          roleIds: [...member.roles.cache.keys()].filter((roleId) => roleId !== guild.id),
        }));
        this.guildMemberSnapshots.set(guildId, { expiresAt: Date.now() + 5 * 60_000, data });
        if (cache.backend !== 'memory') await cache.setJson(`guild-members:${guildId}`, data, 300);
        this.guildMemberRetryAt.delete(guildId);
        return data;
      } catch (error) {
        const retryAfter = Number((error as { retry_after?: number }).retry_after || String(error).match(/retry after\s+([\d.]+)/i)?.[1] || 30);
        this.guildMemberRetryAt.set(guildId, Date.now() + Math.max(5, retryAfter) * 1000);
        if (snapshot) {
          console.warn(`[bot] Discord member fetch was rate limited for ${guildId}. Serving cached snapshot.`, error);
          return snapshot.data;
        }
        throw error;
      }
    })();
    this.guildMemberFetches.set(guildId, task);
    try {
      return await task;
    } finally {
      this.guildMemberFetches.delete(guildId);
    }
  }

  async listLiveRooms(guildId: string, actorId: string, includeAll = false): Promise<LiveRoomView[]> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Bot chưa ở trong server.');
    const rooms = (await store.listRooms(guildId)).filter((room) => includeAll || room.ownerId === actorId);
    const result: LiveRoomView[] = [];
    for (const room of rooms) {
      const channel = await this.resolveOrForgetRoom(room);
      if (!channel) continue;
      const everyoneOverwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      result.push({
        id: room.id,
        channelId: room.channelId,
        name: channel.name,
        ownerId: room.ownerId,
        ownerTag: room.ownerTag,
        originalOwnerId: room.originalOwnerId || room.ownerId,
        editable: room.mode === 'editable',
        creatorChannelId: room.creatorChannelId,
        userLimit: channel.userLimit,
        locked: Boolean(everyoneOverwrite?.deny.has(PermissionFlagsBits.Connect)),
        hidden: Boolean(everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel)),
        passwordEnabled: Boolean(room.passwordHash),
        notifyJoinLeave: room.notifyJoinLeave,
        createdAt: room.createdAt,
        members: [...channel.members.values()].map((member) => ({ id: member.id, displayName: member.displayName, username: member.user.username, avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 64 }), bot: member.user.bot })),
      });
    }
    return result;
  }

  async manageRoom(input: { guildId: string; actorId: string; admin: boolean; channelId: string; action: RoomDashboardAction; value?: string | number | boolean; targetUserId?: string }): Promise<string> {
    const guild = this.client.guilds.cache.get(input.guildId);
    const room = await store.getRoomByChannel(input.channelId);
    if (!guild || !room) throw new Error('Phòng không còn tồn tại.');
    const channel = await this.resolveOrForgetRoom(room);
    if (!channel) throw new Error('Phòng không còn tồn tại.');
    if (!input.admin && room.ownerId !== input.actorId) throw new Error('Bạn chỉ có thể quản lý phòng mình đang host.');
    if (input.action !== 'delete' && room.mode !== 'editable') throw new Error('Phòng này được tạo từ trigger không chỉnh sửa.');

    if (input.action === 'rename') {
      const name = String(input.value || '').trim().slice(0, 100);
      if (!name) throw new Error('Tên phòng không được để trống.');
      await channel.setName(name, `Dashboard action by ${input.actorId}`);
      return `Đã đổi tên phòng thành ${name}.`;
    }
    if (input.action === 'limit') {
      const limit = Math.min(99, Math.max(0, Math.round(Number(input.value || 0))));
      await channel.setUserLimit(limit, `Dashboard action by ${input.actorId}`);
      return `Đã đặt limit ${limit || 'không giới hạn'}.`;
    }
    if (input.action === 'lock') {
      const locked = channel.permissionOverwrites.cache.get(guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.Connect);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { Connect: locked ? null : false });
      await channel.permissionOverwrites.edit(room.ownerId, { Connect: true, ViewChannel: true });
      if (room.originalOwnerId && room.originalOwnerId !== room.ownerId) await channel.permissionOverwrites.edit(room.originalOwnerId, { Connect: true, ViewChannel: true }).catch(() => undefined);
      return locked ? 'Đã mở khóa phòng.' : 'Đã khóa phòng.';
    }
    if (input.action === 'hide') {
      const hidden = channel.permissionOverwrites.cache.get(guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: hidden ? null : false });
      await channel.permissionOverwrites.edit(room.ownerId, { Connect: true, ViewChannel: true });
      if (room.originalOwnerId && room.originalOwnerId !== room.ownerId) await channel.permissionOverwrites.edit(room.originalOwnerId, { Connect: true, ViewChannel: true }).catch(() => undefined);
      return hidden ? 'Đã hiện phòng.' : 'Đã ẩn phòng.';
    }
    if (input.action === 'password') {
      const password = String(input.value || '').trim();
      await store.clearRoomAccess(room.id);
      const salt = password ? crypto.randomBytes(16).toString('hex') : '';
      const updated = (await store.updateRoom(room.channelId, {
        passwordSalt: salt,
        passwordHash: password ? await passwordDigest(password, salt) : '',
      }))!;
      await this.refreshRoomPanel(updated);
      return password ? 'Đã bật/đổi mật khẩu.' : 'Đã tắt mật khẩu.';
    }
    if (input.action === 'notifications') {
      const updated = (await store.updateRoom(room.channelId, { notifyJoinLeave: Boolean(input.value) }))!;
      await this.refreshRoomPanel(updated);
      return `Đã ${updated.notifyJoinLeave ? 'bật' : 'tắt'} thông báo ra/vào.`;
    }
    if (input.action === 'invite') {
      const target = await guild.members.fetch(String(input.targetUserId || '')).catch(() => null);
      if (!target) throw new Error('Không tìm thấy member cần mời.');
      await store.grantRoomAccess(room.id, target.id);
      await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true });
      return `Đã mời ${target.user.tag}.`;
    }
    if (input.action === 'kick' || input.action === 'transfer') {
      const target = await guild.members.fetch(String(input.targetUserId || '')).catch(() => null);
      if (!target || target.voice.channelId !== room.channelId) throw new Error('Member không ở trong phòng.');
      if (target.id === room.ownerId) throw new Error('Không thể chọn host hiện tại.');
      if (input.action === 'kick') {
        await store.revokeRoomAccess(room.id, target.id);
        await channel.permissionOverwrites.delete(target.id, 'Thu hồi quyền khi bị kick').catch(() => undefined);
        await target.voice.disconnect(`Dashboard kick by ${input.actorId}`).catch(() => undefined);
        await this.removeRoomIfEmpty(room.channelId, 'Phòng trống sau khi kick');
        return `Đã kick ${target.user.tag} và thu hồi quyền truy cập.`;
      }
      await this.transferOwnership(room, target, `Chuyển từ Dashboard bởi <@${input.actorId}>.`);
      return `Đã chuyển host cho ${target.user.tag}.`;
    }
    if (input.action === 'delete') {
      this.roomGrace.delete(room.channelId);
      await store.deleteRoomByChannel(room.channelId);
      await channel.delete(`Dashboard delete by ${input.actorId}`).catch(() => undefined);
      return 'Đã xóa phòng.';
    }
    throw new Error('Thao tác không được hỗ trợ.');
  }

  async createCreatorChannel(guild: Guild, input: { label: string; mode: 'basic' | 'editable'; categoryId?: string; allowedRoleId?: string; notifyJoinLeave?: boolean; autoTransferOwner?: boolean }): Promise<CreatorChannelConfig> {
    const label = input.label.trim().slice(0, 100) || 'Tạo phòng';
    let parentId = input.categoryId || '';
    if (parentId) {
      const parent = guild.channels.cache.get(parentId);
      if (!parent || parent.type !== ChannelType.GuildCategory) throw new Error('Category ID không hợp lệ hoặc bot không thấy category.');
    }
    if (input.allowedRoleId && !guild.roles.cache.has(input.allowedRoleId)) throw new Error('Allowed Role ID không tồn tại trong server.');
    const channel = await guild.channels.create({ name: label, type: ChannelType.GuildVoice, parent: parentId || undefined, reason: `SGF create ${input.mode} creator channel` });
    const settings = await store.getSettings(guild.id, guild.name);
    const creator: CreatorChannelConfig = {
      channelId: channel.id,
      label,
      mode: input.mode,
      ...(parentId ? { categoryId: parentId } : {}),
      ...(input.allowedRoleId ? { allowedRoleId: input.allowedRoleId } : {}),
      notifyJoinLeave: Boolean(input.notifyJoinLeave),
      autoTransferOwner: input.autoTransferOwner !== false,
    };
    await store.updateSettings(guild.id, { creatorChannels: [...settings.creatorChannels, creator] });
    return creator;
  }

  async postPaymentPanel(guild: Guild, providedSettings?: GuildSettings): Promise<string> {
    const settings = providedSettings || await store.getSettings(guild.id, guild.name);
    const channelId = settings.paymentPanelChannelId;
    if (!channelId) return 'Chưa cấu hình kênh payment panel. Dùng `/sgf setup` với option `payment_channel` trước.';
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return 'Kênh payment panel đã cấu hình không còn hợp lệ. Hãy chọn lại bằng `/sgf setup`.';
    const products = await store.listProducts(guild.id, true);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('SGF Premium theo tháng')
      .setDescription('Free: 1 phòng editable/server. Premium: không giới hạn phòng editable, nhắc gia hạn trước 3 ngày và gia hạn cộng tiếp từ ngày hết hạn. Hoặc Donate để ủng hộ server.');
    const buttons = this.paymentButtonRow(products)!;
    await channel.send({ embeds: [embed], components: [buttons] });
    return `Đã đăng payment panel vào <#${channel.id}>${products.length > 4 ? ' (hiển thị 4 gói đầu)' : ''}.`;
  }

  async handleSepayWebhook(payload: import('./types.js').SepayWebhookPayload): Promise<ReturnType<typeof settleSepayWebhook>> {
    return settleSepayWebhook(this.client, payload);
  }
}
