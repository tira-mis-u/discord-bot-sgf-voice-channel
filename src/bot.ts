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
  type UserSelectMenuInteraction,
  type VoiceState,
} from 'discord.js';
import { config } from './config.js';
import { store } from './db.js';
import type { CreatorChannelConfig, GuildSettings, Room } from './types.js';
import type { PaymentCreationResult } from './services/payment-service.js';
import { formatVnd } from './utils.js';
import { createDonationPayment, createProductPayment, settleSepayWebhook } from './services/payment-service.js';

function isAdmin(interaction: Interaction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function displayName(member: GuildMember): string {
  return member.displayName || member.user.globalName || member.user.username;
}

function roomName(settings: GuildSettings, member: GuildMember): string {
  const template = settings.roomNameTemplate || "{user}'s room";
  const value = template.replace(/\{user\}/gi, displayName(member)).replace(/\{tag\}/gi, member.user.username);
  return value.slice(0, 100) || `${displayName(member)}'s room`;
}

function channelIsEmpty(channel: { members?: Map<string, GuildMember> }): boolean {
  return !channel.members || channel.members.size === 0;
}

function passwordDigest(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function passwordMatches(password: string, room: Room): boolean {
  if (!room.passwordHash || !room.passwordSalt) return true;
  const actual = Buffer.from(passwordDigest(password, room.passwordSalt), 'hex');
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
  private expiryTimer?: NodeJS.Timeout;
  private lastError = '';
  private readyAt = '';

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
    });
    this.registerListeners();
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
      this.expiryTimer = setInterval(() => void this.runMaintenance(), 60_000);
    });
    this.client.on(Events.GuildCreate, async (guild) => {
      await guild.members.fetchMe().catch((error) => console.warn(`[bot] cannot fetch own member in ${guild.id}`, error));
      await this.registerSlashCommands(guild);
    });
    this.client.on(Events.GuildMemberAdd, (member) => this.guildMemberSnapshots.delete(member.guild.id));
    this.client.on(Events.GuildMemberRemove, (member) => this.guildMemberSnapshots.delete(member.guild.id));
    this.client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
      await this.onVoiceStateUpdate(oldState, newState).catch((error) => console.error('[bot] voice state error', error));
    });
    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        await this.onInteraction(interaction);
      } catch (error) {
        console.error('[bot] interaction error', error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Có lỗi xảy ra, thử lại sau nhé.', ephemeral: Boolean(interaction.guild) }).catch(() => undefined);
        }
      }
    });
    this.client.on(Events.ChannelDelete, (channel) => {
      store.deleteRoomByChannel(channel.id);
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
      await interaction.reply({ content: 'Hãy dùng lệnh này trong một server Discord.' });
      return;
    }
    if (interaction.commandName !== 'sgf') return;
    const subcommand = interaction.options.getSubcommand();
    const adminOnly = ['setup', 'panel', 'status', 'sync'].includes(subcommand);
    if (adminOnly && !isAdmin(interaction)) {
      await interaction.reply({ content: 'Lệnh này chỉ dành cho admin server.', ephemeral: true });
      return;
    }

    const settings = store.getSettings(interaction.guild.id, interaction.guild.name);
    if (subcommand === 'help') return this.sendHelp(interaction);
    if (subcommand === 'donate') {
      await interaction.showModal(this.donationModal());
      return;
    }
    if (subcommand === 'premium') {
      const products = store.listProducts(interaction.guild.id, true);
      const row = this.paymentButtonRow(products);
      const entitlement = store.getEntitlement(interaction.guild.id, interaction.user.id);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined })
        .setTitle('Premium và Donate')
        .setDescription(products.length ? 'Premium cho phép host mở không giới hạn phòng editable. Bản miễn phí được giữ 1 phòng editable trên mỗi server.' : 'Server chưa mở bán gói Premium. Bạn vẫn có thể chọn Donate để ủng hộ.')
        .addFields(
          { name: 'Trạng thái của bạn', value: entitlement ? `Premium đến **${entitlement.expiresAt ? new Date(entitlement.expiresAt).toLocaleDateString('vi-VN') : 'vĩnh viễn'}**` : 'Free - 1 phòng editable trên mỗi server', inline: false },
          { name: 'Gia hạn', value: 'Thanh toán sớm sẽ cộng thêm thời gian kể từ ngày hết hạn hiện tại.', inline: false },
        )
        .setFooter({ text: 'Bot sẽ nhắc gia hạn trước 3 ngày' })
        .setTimestamp();
      await interaction.reply({ ephemeral: true, embeds: [embed], components: row ? [row] : [] });
      return;
    }
    if (subcommand === 'room') {
      const currentChannelId = interaction.member instanceof GuildMember ? interaction.member.voice.channelId : '';
      const currentRoom = currentChannelId ? store.getRoomByChannel(currentChannelId) : undefined;
      const room = currentRoom?.ownerId === interaction.user.id ? currentRoom : store.getRoomByOwner(interaction.guild.id, interaction.user.id);
      if (!room) {
        await interaction.reply({ content: 'Bạn chưa host phòng tạm nào. Hãy vào creator voice channel trước.', ephemeral: true });
        return;
      }
      await interaction.reply({ content: `Bảng điều khiển cho <#${room.channelId}>`, embeds: [this.roomPanelEmbed(room)], components: this.roomButtonRows(room), ephemeral: true });
      return;
    }
    if (subcommand === 'setup') return this.runSetup(interaction, settings);
    if (subcommand === 'panel') {
      const result = await this.postPaymentPanel(interaction.guild, settings);
      await interaction.reply({ content: result, ephemeral: true });
      return;
    }
    if (subcommand === 'sync') {
      await this.registerSlashCommands(interaction.guild);
      await interaction.reply({ content: 'Đã đồng bộ command `/sgf` và xóa các slash command cũ bị trùng.', ephemeral: true });
      return;
    }
    if (subcommand === 'status') {
      const stats = store.getStats(interaction.guild.id);
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
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  private async sendHelp(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: 'SGF Control Center', iconURL: this.client.user?.displayAvatarURL() })
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
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
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
    if (controlChannel) patch.controlChannelId = controlChannel.id;
    if (paymentChannel) patch.paymentPanelChannelId = paymentChannel.id;
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
    const settings = Object.keys(patch).length ? store.updateSettings(interaction.guild!.id, patch) : currentSettings;
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
    await interaction.reply({ embeds: [embed], components: [setupRow], ephemeral: true });
  }

  private async onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot || oldState.channelId === newState.channelId) return;
    const guild = newState.guild;

    if (newState.channelId) {
      const settings = store.getSettings(guild.id, guild.name);
      const creator = settings.creatorChannels.find((item) => item.channelId === newState.channelId);
      if (creator) {
        await this.createRoomFromTrigger(member, creator, settings, oldState.channelId);
      } else {
        const joinedRoom = store.getRoomByChannel(newState.channelId);
        if (joinedRoom) {
          const allowed = await this.enforceRoomPassword(member, joinedRoom);
          if (allowed && joinedRoom.notifyJoinLeave) await this.sendRoomNotice(joinedRoom, `➡️ <@${member.id}> đã **vào phòng**.`);
        }
      }
    }

    if (oldState.channelId) {
      const leftRoom = store.getRoomByChannel(oldState.channelId);
      if (leftRoom) {
        const rejectedKey = `${leftRoom.channelId}:${member.id}`;
        const rejected = this.rejectedPasswordLeaves.delete(rejectedKey);
        if (!rejected && leftRoom.notifyJoinLeave) await this.sendRoomNotice(leftRoom, `⬅️ <@${member.id}> đã **rời phòng**.`);
        if (leftRoom.ownerId === member.id) await this.autoTransferOwnership(leftRoom);
        await this.removeRoomIfEmpty(leftRoom.channelId);
      }
    }
  }

  private async createRoomFromTrigger(member: GuildMember, creator: CreatorChannelConfig, settings: GuildSettings, previousChannelId: string | null): Promise<void> {
    const key = `${member.guild.id}:${member.id}`;
    if (this.creatingOwners.has(key)) return;
    this.creatingOwners.add(key);
    try {
      if (creator.allowedRoleId && !member.roles.cache.has(creator.allowedRoleId) && !member.permissions.has(PermissionFlagsBits.Administrator)) {
        await member.send(`Bạn cần role <@&${creator.allowedRoleId}> để dùng creator **${creator.label}** trong **${member.guild.name}**.`).catch(() => undefined);
        if (previousChannelId) await member.voice.setChannel(previousChannelId, 'Thiếu role để tạo phòng').catch(() => undefined);
        else await member.voice.disconnect('Thiếu role để tạo phòng').catch(() => undefined);
        return;
      }

      const premium = this.isPremium(member, settings);
      if (creator.mode === 'basic') {
        const existing = store.getRoomByOwnerAndCreator(member.guild.id, member.id, creator.channelId);
        const existingChannel = existing ? member.guild.channels.cache.get(existing.channelId) : undefined;
        if (existing && existingChannel?.isVoiceBased()) {
          await member.voice.setChannel(existingChannel, 'Dùng lại phòng cơ bản đang có').catch(() => undefined);
          return;
        }
        if (existing) store.deleteRoomByChannel(existing.channelId);
      }

      if (creator.mode === 'editable' && !premium) {
        const editableRooms = store.listRoomsByOwner(member.guild.id, member.id).filter((room) => room.mode === 'editable');
        const activeRooms = editableRooms.filter((room) => {
          const channel = member.guild.channels.cache.get(room.channelId);
          if (!channel?.isVoiceBased()) store.deleteRoomByChannel(room.channelId);
          return Boolean(channel?.isVoiceBased());
        });
        if (activeRooms.length) {
          const first = activeRooms[0];
          const firstChannel = member.guild.channels.cache.get(first.channelId);
          if (firstChannel?.isVoiceBased()) {
            await member.voice.setChannel(firstChannel, 'Free chỉ được một phòng editable/server').catch(() => undefined);
            await member.send(`Bản Free giữ tối đa **1 phòng editable/server**. Bot đã chuyển bạn về <#${first.channelId}>. Premium cho phép mở không giới hạn.`).catch(() => undefined);
            return;
          }
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

      const room = store.insertRoom({
        guildId: member.guild.id,
        channelId: channel.id,
        ownerId: member.id,
        ownerTag: member.user.tag,
        mode: creator.mode,
        creatorChannelId: creator.channelId,
        controlMessageId: '',
        notifyJoinLeave: Boolean(creator.notifyJoinLeave),
        passwordHash: '',
        passwordSalt: '',
      });
      let controlMessageId = '';
      try {
        controlMessageId = await this.sendRoomControlPanel(member.guild, room);
      } catch (error) {
        console.warn(`[bot] cannot send room panel in voice chat ${channel.id}`, error);
      }
      store.updateRoom(channel.id, { controlMessageId });
      try {
        await member.voice.setChannel(channel, 'SGF tạo phòng tạm và chuyển host');
      } catch (error) {
        await channel.delete('Không move được chủ phòng').catch(() => undefined);
        store.deleteRoomByChannel(channel.id);
        throw new Error('Bot tạo được phòng nhưng không chuyển được member. Kiểm tra quyền Move Members và Connect.', { cause: error });
      }
    } catch (error) {
      console.error(`[bot] cannot create room for ${member.user.tag} in ${member.guild.id}`, error);
      await member.send(`Không tạo được phòng trong **${member.guild.name}**: ${error instanceof Error ? error.message : 'Lỗi không xác định'}`).catch(() => undefined);
      if (member.voice.channelId === creator.channelId) {
        if (previousChannelId) await member.voice.setChannel(previousChannelId, 'Hoàn tác vì tạo phòng lỗi').catch(() => undefined);
        else await member.voice.disconnect('Tạo phòng thất bại').catch(() => undefined);
      }
    } finally {
      this.creatingOwners.delete(key);
    }
  }

  private async enforceRoomPassword(member: GuildMember, room: Room): Promise<boolean> {
    if (!room.passwordHash || member.id === room.ownerId || member.permissions.has(PermissionFlagsBits.Administrator) || store.hasRoomAccess(room.id, member.id)) return true;
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
    for (const entitlement of store.listEntitlementsNeedingReminder(3)) {
      const guild = this.client.guilds.cache.get(entitlement.guildId);
      const user = await this.client.users.fetch(entitlement.discordUserId).catch(() => null);
      if (user) {
        const product = store.getProduct(entitlement.productId);
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
      store.markEntitlementReminder(entitlement.id);
    }
  }

  private async expireDueEntitlements(): Promise<void> {
    const due = store.expireDueEntitlements();
    const downgraded = new Set<string>();
    for (const entitlement of due) {
      const guild = this.client.guilds.cache.get(entitlement.guildId);
      if (!guild) continue;
      const member = await guild.members.fetch(entitlement.discordUserId).catch(() => null);
      if (member && entitlement.roleId && !store.hasActiveEntitlementForRole(entitlement.guildId, entitlement.discordUserId, entitlement.roleId)) {
        await member.roles.remove(entitlement.roleId, 'SGF Premium entitlement expired').catch(() => undefined);
      }
      const key = `${entitlement.guildId}:${entitlement.discordUserId}`;
      if (downgraded.has(key) || store.hasActiveEntitlement(entitlement.guildId, entitlement.discordUserId)) continue;
      downgraded.add(key);
      const editableRooms = store.listRoomsByOwner(entitlement.guildId, entitlement.discordUserId).filter((room) => room.mode === 'editable');
      const activeEditableRooms = editableRooms.filter((room) => {
        const channel = guild.channels.cache.get(room.channelId);
        if (!channel?.isVoiceBased()) store.deleteRoomByChannel(room.channelId);
        return Boolean(channel?.isVoiceBased());
      });
      const removed: string[] = [];
      for (const room of activeEditableRooms.slice(1)) {
        const channel = guild.channels.cache.get(room.channelId);
        store.deleteRoomByChannel(room.channelId);
        if (channel?.isVoiceBased()) await channel.delete('Premium hết hạn: giữ phòng editable đầu tiên').catch(() => undefined);
        removed.push(room.channelId);
      }
      if (member) {
        await member.send(`Premium tại **${guild.name}** đã hết hạn.${removed.length ? ` Bot đã đóng ${removed.length} phòng editable vượt giới hạn Free và giữ lại phòng đầu tiên.` : ' Bạn vẫn được dùng 1 phòng editable theo gói Free.'}`).catch(() => undefined);
      }
    }
  }

  private isPremium(member: GuildMember, _settings: GuildSettings): boolean {
    return store.hasActiveEntitlement(member.guild.id, member.id);
  }

  private canReceiveOwnership(room: Room, member: GuildMember): boolean {
    if (room.mode !== 'editable' || store.hasActiveEntitlement(member.guild.id, member.id)) return true;
    return !store.listRoomsByOwner(member.guild.id, member.id).some((ownedRoom) => ownedRoom.mode === 'editable' && ownedRoom.channelId !== room.channelId && member.guild.channels.cache.get(ownedRoom.channelId)?.isVoiceBased());
  }

  private async autoTransferOwnership(room: Room): Promise<void> {
    const guild = this.client.guilds.cache.get(room.guildId);
    const channel = guild?.channels.cache.get(room.channelId);
    if (!guild || !channel?.isVoiceBased()) return;
    const creator = store.getSettings(room.guildId).creatorChannels.find((item) => item.channelId === room.creatorChannelId);
    if (creator?.autoTransferOwner === false) return;
    const nextHost = [...channel.members.values()].find((member) => !member.user.bot && member.id !== room.ownerId && this.canReceiveOwnership(room, member));
    if (nextHost) await this.transferOwnership(room, nextHost, 'Host cũ rời phòng');
    else if (channel.members.size > 0) await this.sendRoomNotice(room, '⚠️ Chưa thể tự chuyển host vì các member còn lại đã đạt giới hạn phòng editable của gói Free.');
  }

  private async transferOwnership(room: Room, nextHost: GuildMember, reason: string): Promise<Room> {
    const channel = nextHost.guild.channels.cache.get(room.channelId);
    if (!channel?.isVoiceBased()) throw new Error('Phòng không còn tồn tại.');
    if (!this.canReceiveOwnership(room, nextHost)) throw new Error('Member này đã có 1 phòng editable theo giới hạn Free. Hãy chọn member Premium hoặc đóng phòng cũ trước.');
    const oldOwnerId = room.ownerId;
    await channel.permissionOverwrites.edit(oldOwnerId, { ViewChannel: null, Connect: null, Speak: null }).catch(() => undefined);
    await channel.permissionOverwrites.edit(nextHost.id, { ViewChannel: true, Connect: true, Speak: true });
    const updated = store.updateRoom(room.channelId, { ownerId: nextHost.id, ownerTag: nextHost.user.tag })!;
    await this.sendRoomNotice(updated, `👑 <@${nextHost.id}> đã trở thành **host mới**. ${reason}`);
    await this.refreshRoomPanel(updated);
    return updated;
  }

  private async removeRoomIfEmpty(channelId: string): Promise<void> {
    const room = store.getRoomByChannel(channelId);
    if (!room) return;
    const channel = this.client.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased() || channelIsEmpty(channel)) {
      store.deleteRoomByChannel(channelId);
      if (channel?.isVoiceBased()) await channel.delete('Phòng tạm đã trống').catch(() => undefined);
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
    return new EmbedBuilder()
      .setColor(editable ? 0x5865f2 : 0x64748b)
      .setTitle(editable ? 'Bảng điều khiển phòng' : 'Phòng cơ bản')
      .setDescription(`Host: <@${room.ownerId}>\nChế độ: **${editable ? 'Editable' : 'Không chỉnh sửa'}**\nMật khẩu: **${room.passwordHash ? 'Đang bật' : 'Tắt'}**\nThông báo ra/vào: **${room.notifyJoinLeave ? 'Bật' : 'Tắt'}**\n\n${editable ? 'Chỉ host hiện tại hoặc admin server có thể dùng các nút.' : 'Phòng cơ bản chỉ có thể xóa. Hãy dùng creator editable để mở toàn bộ control.'}`)
      .setFooter({ text: 'Panel nằm trong chat của voice room. Phòng tự xóa khi trống' });
  }

  private async sendRoomControlPanel(guild: Guild, room: Room): Promise<string> {
    const channel = guild.channels.cache.get(room.channelId);
    if (!channel?.isVoiceBased() || !channel.isTextBased()) return '';
    const message = await channel.send({ embeds: [this.roomPanelEmbed(room)], components: this.roomButtonRows(room) });
    return message.id;
  }

  private async refreshRoomPanel(room: Room): Promise<void> {
    if (!room.controlMessageId) return;
    const guild = this.client.guilds.cache.get(room.guildId);
    const channel = guild?.channels.cache.get(room.channelId);
    if (!channel?.isVoiceBased() || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(room.controlMessageId).catch(() => null);
    if (message) await message.edit({ embeds: [this.roomPanelEmbed(room)], components: this.roomButtonRows(room) }).catch(() => undefined);
  }

  private async sendRoomNotice(room: Room, content: string): Promise<void> {
    const guild = this.client.guilds.cache.get(room.guildId);
    const channel = guild?.channels.cache.get(room.channelId);
    if (channel?.isVoiceBased() && channel.isTextBased()) await channel.send({ content, allowedMentions: { users: [] } }).catch(() => undefined);
  }

  private paymentButtonRow(products: ReturnType<typeof store.listProducts>): ActionRowBuilder<ButtonBuilder> | undefined {
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
      const room = store.getRoomByChannel(value);
      if (!room) {
        await interaction.reply({ content: 'Phòng không còn tồn tại.' });
        return;
      }
      const modal = new ModalBuilder().setCustomId(`roompassmodal:verify:${value}`).setTitle('Nhập mật khẩu phòng');
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('password').setLabel('Mật khẩu').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64)));
      await interaction.showModal(modal);
      return;
    }
    if (namespace === 'pay') return this.onPaymentButton(interaction, action, value);
  }

  private async onRoomButton(interaction: ButtonInteraction, action: string, channelId: string): Promise<void> {
    const room = store.getRoomByChannel(channelId);
    if (!room || !interaction.guild) {
      await interaction.reply({ content: 'Phòng này không còn tồn tại.', ephemeral: Boolean(interaction.guild) });
      return;
    }
    if (interaction.user.id !== room.ownerId && !isAdmin(interaction)) {
      await interaction.reply({ content: 'Chỉ host hiện tại hoặc admin mới dùng được bảng này.', ephemeral: true });
      return;
    }
    if (action !== 'delete' && room.mode !== 'editable') {
      await interaction.reply({ content: 'Creator của phòng này được đặt ở chế độ không chỉnh sửa.', ephemeral: true });
      return;
    }
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      store.deleteRoomByChannel(channelId);
      await interaction.reply({ content: 'Kênh đã bị xóa.', ephemeral: true });
      return;
    }
    if (action === 'rename' || action === 'limit' || action === 'password') {
      const titles = { rename: 'Đổi tên phòng', limit: 'Giới hạn thành viên', password: 'Mật khẩu phòng' } as const;
      const modal = new ModalBuilder().setCustomId(`roommodal:${action}:${channelId}`).setTitle(titles[action]);
      const input = action === 'rename'
        ? new TextInputBuilder().setCustomId('name').setLabel('Tên mới').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(channel.name)
        : action === 'limit'
          ? new TextInputBuilder().setCustomId('limit').setLabel('0 để bỏ giới hạn, tối đa 99').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(channel.userLimit || 0))
          : new TextInputBuilder().setCustomId('password').setLabel('Để trống để tắt mật khẩu').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(64);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }
    if (['invite', 'kick', 'transfer'].includes(action)) {
      const labels: Record<string, string> = { invite: 'Chọn người muốn mời', kick: 'Chọn người muốn kick', transfer: 'Chọn host mới' };
      const select = new UserSelectMenuBuilder().setCustomId(`roomuser:${action}:${channelId}`).setPlaceholder(labels[action]).setMinValues(1).setMaxValues(1);
      await interaction.reply({ content: labels[action], components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)], ephemeral: true });
      return;
    }
    if (action === 'lock') {
      const everyone = interaction.guild.roles.everyone;
      const locked = channel.permissionOverwrites.cache.get(everyone.id)?.deny.has(PermissionFlagsBits.Connect);
      await channel.permissionOverwrites.edit(everyone, { Connect: locked ? null : false });
      await channel.permissionOverwrites.edit(room.ownerId, { Connect: true, ViewChannel: true });
      await interaction.reply({ content: locked ? '🔓 Đã mở khóa phòng.' : '🔒 Đã khóa phòng với người ngoài.', ephemeral: true });
      return;
    }
    if (action === 'hide') {
      const everyone = interaction.guild.roles.everyone;
      const hidden = channel.permissionOverwrites.cache.get(everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel);
      await channel.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false });
      await channel.permissionOverwrites.edit(room.ownerId, { ViewChannel: true, Connect: true });
      await interaction.reply({ content: hidden ? '👁️ Đã hiện phòng.' : '🙈 Đã ẩn phòng khỏi thành viên khác.', ephemeral: true });
      return;
    }
    if (action === 'notify') {
      const updated = store.updateRoom(channelId, { notifyJoinLeave: !room.notifyJoinLeave })!;
      await this.refreshRoomPanel(updated);
      await interaction.reply({ content: `🔔 Thông báo người ra/vào đã **${updated.notifyJoinLeave ? 'bật' : 'tắt'}**.`, ephemeral: true });
      return;
    }
    if (action === 'delete') {
      store.deleteRoomByChannel(channelId);
      await channel.delete('Host/admin xóa phòng tạm').catch(() => undefined);
      await interaction.reply({ content: '🗑️ Đã xóa phòng.', ephemeral: true });
    }
  }

  private async onUserSelect(interaction: UserSelectMenuInteraction): Promise<void> {
    const [namespace, action, channelId] = interaction.customId.split(':');
    if (namespace !== 'roomuser' || !interaction.guild) return;
    const room = store.getRoomByChannel(channelId);
    if (!room || (interaction.user.id !== room.ownerId && !isAdmin(interaction))) {
      await interaction.reply({ content: 'Bạn không còn quyền điều khiển phòng này.', ephemeral: true });
      return;
    }
    const targetId = interaction.values[0];
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!target || !channel?.isVoiceBased()) {
      await interaction.reply({ content: 'Không tìm thấy member hoặc phòng.', ephemeral: true });
      return;
    }
    if (action === 'invite') {
      store.grantRoomAccess(room.id, target.id);
      await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true });
      await interaction.reply({ content: `✅ Đã mời <@${target.id}> vào phòng.`, ephemeral: true });
      return;
    }
    if (target.voice.channelId !== channelId) {
      await interaction.reply({ content: 'Member được chọn hiện không ở trong phòng.', ephemeral: true });
      return;
    }
    if (target.id === room.ownerId) {
      await interaction.reply({ content: 'Không thể kick hoặc chuyển host cho chính host hiện tại.', ephemeral: true });
      return;
    }
    if (action === 'kick') {
      store.revokeRoomAccess(room.id, target.id);
      await channel.permissionOverwrites.delete(target.id, 'Thu hồi quyền khi bị kick').catch(() => undefined);
      await target.voice.disconnect(`Bị kick khỏi phòng bởi ${interaction.user.tag}`);
      await interaction.reply({ content: `👢 Đã kick <@${target.id}> và thu hồi quyền mời/password.`, ephemeral: true });
      return;
    }
    if (action === 'transfer') {
      try {
        await this.transferOwnership(room, target, `Chuyển bởi <@${interaction.user.id}>.`);
        await interaction.reply({ content: `👑 Đã chuyển host cho <@${target.id}>.`, ephemeral: true });
      } catch (error) {
        await interaction.reply({ content: error instanceof Error ? error.message : 'Không chuyển được host.', ephemeral: true });
      }
    }
  }

  private async onModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [namespace, action, channelId] = interaction.customId.split(':');
    if (namespace === 'payment') return this.onDonationModal(interaction);
    if (namespace === 'roompassmodal' && action === 'verify') {
      const room = store.getRoomByChannel(channelId);
      const attemptKey = `${channelId}:${interaction.user.id}`;
      const attempt = this.passwordAttempts.get(attemptKey);
      if (attempt && attempt.resetAt > Date.now() && attempt.count >= 5) {
        await interaction.reply({ content: '⏳ Bạn đã nhập sai quá nhiều lần. Hãy thử lại sau 5 phút.' });
        return;
      }
      const password = interaction.fields.getTextInputValue('password');
      if (!room || !passwordMatches(password, room)) {
        const current = attempt && attempt.resetAt > Date.now() ? attempt : { count: 0, resetAt: Date.now() + 5 * 60_000 };
        this.passwordAttempts.set(attemptKey, { ...current, count: current.count + 1 });
        await interaction.reply({ content: `❌ Mật khẩu không đúng hoặc phòng đã bị xóa. Còn ${Math.max(0, 5 - current.count - 1)} lần thử trước khi tạm khóa.` });
        return;
      }
      this.passwordAttempts.delete(attemptKey);
      store.grantRoomAccess(room.id, interaction.user.id);
      await interaction.reply({ content: `✅ Đúng mật khẩu. Bạn có thể vào lại phòng <#${room.channelId}>.` });
      return;
    }
    if (namespace !== 'roommodal' || !interaction.guild) return;
    const room = store.getRoomByChannel(channelId);
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!room || !channel?.isVoiceBased()) {
      await interaction.reply({ content: 'Phòng không còn tồn tại.', ephemeral: true });
      return;
    }
    if (interaction.user.id !== room.ownerId && !isAdmin(interaction)) {
      await interaction.reply({ content: 'Chỉ host hoặc admin mới thao tác được.', ephemeral: true });
      return;
    }
    if (action === 'rename') {
      const name = interaction.fields.getTextInputValue('name').trim().slice(0, 100);
      await channel.setName(name, 'Đổi tên bởi host');
      await interaction.reply({ content: `✏️ Đã đổi tên thành **${name}**.`, ephemeral: true });
      return;
    }
    if (action === 'limit') {
      const raw = Number(interaction.fields.getTextInputValue('limit'));
      const limit = Number.isFinite(raw) ? Math.min(99, Math.max(0, Math.round(raw))) : -1;
      if (limit < 0) {
        await interaction.reply({ content: 'Nhập số từ 0 đến 99.', ephemeral: true });
        return;
      }
      await channel.setUserLimit(limit, 'Đổi giới hạn bởi host');
      await interaction.reply({ content: `👥 Đã đặt giới hạn: **${limit === 0 ? 'Không giới hạn' : limit}**.`, ephemeral: true });
      return;
    }
    if (action === 'password') {
      const password = interaction.fields.getTextInputValue('password').trim();
      const updated = password
        ? (() => {
          const salt = crypto.randomBytes(16).toString('hex');
          store.clearRoomAccess(room.id);
          return store.updateRoom(channelId, { passwordSalt: salt, passwordHash: passwordDigest(password, salt) })!;
        })()
        : (() => {
          store.clearRoomAccess(room.id);
          return store.updateRoom(channelId, { passwordSalt: '', passwordHash: '' })!;
        })();
      await this.refreshRoomPanel(updated);
      await interaction.reply({ content: password ? '🔐 Đã bật/đổi mật khẩu phòng.' : '🔓 Đã tắt mật khẩu phòng.', ephemeral: true });
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
    try {
      const result = createProductPayment({ guildId: interaction.guild.id, userId: interaction.user.id, userTag: interaction.user.tag, productId });
      await interaction.reply({ ephemeral: true, ...this.paymentMessage(result) });
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : 'Không tạo được đơn thanh toán.', ephemeral: true });
    }
  }

  private async onDonationModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.guild) return;
    const amount = Number(interaction.fields.getTextInputValue('amount').replace(/[^0-9]/g, ''));
    const note = interaction.fields.getTextInputValue('note').trim();
    try {
      const result = createDonationPayment({ guildId: interaction.guild.id, userId: interaction.user.id, userTag: interaction.user.tag, amountVnd: amount, note });
      await interaction.reply({ ephemeral: true, ...this.paymentMessage(result) });
    } catch (error) {
      await interaction.reply({ content: error instanceof Error ? error.message : 'Không tạo được đơn donate.', ephemeral: true });
    }
  }

  private paymentMessage(result: PaymentCreationResult): { content: string; embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const { payment, product, qrDynamic, bankCode, accountNumber, accountName } = result;
    const lines = [
      `**${product?.name || 'Donate cho SGF'}**`,
      `Số tiền: **${formatVnd(payment.expectedAmountVnd)}**`,
      `Nội dung chuyển khoản: **${payment.orderCode}**`,
      bankCode ? `Ngân hàng: **${bankCode}**` : '',
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

  async listGuildMembers(guildId: string, force = false): Promise<GuildMemberView[]> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Bot chưa ở trong server.');
    const snapshot = this.guildMemberSnapshots.get(guildId);
    if (!force && snapshot && snapshot.expiresAt > Date.now()) return snapshot.data;
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
    const rooms = store.listRooms(guildId).filter((room) => includeAll || room.ownerId === actorId);
    const result: LiveRoomView[] = [];
    for (const room of rooms) {
      const channel = guild.channels.cache.get(room.channelId);
      if (!channel?.isVoiceBased()) {
        store.deleteRoomByChannel(room.channelId);
        continue;
      }
      const everyoneOverwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
      result.push({
        id: room.id,
        channelId: room.channelId,
        name: channel.name,
        ownerId: room.ownerId,
        ownerTag: room.ownerTag,
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
    const room = store.getRoomByChannel(input.channelId);
    const channel = guild?.channels.cache.get(input.channelId);
    if (!guild || !room || !channel?.isVoiceBased()) throw new Error('Phòng không còn tồn tại.');
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
      return locked ? 'Đã mở khóa phòng.' : 'Đã khóa phòng.';
    }
    if (input.action === 'hide') {
      const hidden = channel.permissionOverwrites.cache.get(guild.roles.everyone.id)?.deny.has(PermissionFlagsBits.ViewChannel);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: hidden ? null : false });
      await channel.permissionOverwrites.edit(room.ownerId, { Connect: true, ViewChannel: true });
      return hidden ? 'Đã hiện phòng.' : 'Đã ẩn phòng.';
    }
    if (input.action === 'password') {
      const password = String(input.value || '').trim();
      store.clearRoomAccess(room.id);
      const updated = password
        ? (() => { const salt = crypto.randomBytes(16).toString('hex'); return store.updateRoom(room.channelId, { passwordSalt: salt, passwordHash: passwordDigest(password, salt) })!; })()
        : store.updateRoom(room.channelId, { passwordSalt: '', passwordHash: '' })!;
      await this.refreshRoomPanel(updated);
      return password ? 'Đã bật/đổi mật khẩu.' : 'Đã tắt mật khẩu.';
    }
    if (input.action === 'notifications') {
      const updated = store.updateRoom(room.channelId, { notifyJoinLeave: Boolean(input.value) })!;
      await this.refreshRoomPanel(updated);
      return `Đã ${updated.notifyJoinLeave ? 'bật' : 'tắt'} thông báo ra/vào.`;
    }
    if (input.action === 'invite') {
      const target = await guild.members.fetch(String(input.targetUserId || '')).catch(() => null);
      if (!target) throw new Error('Không tìm thấy member cần mời.');
      store.grantRoomAccess(room.id, target.id);
      await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true });
      return `Đã mời ${target.user.tag}.`;
    }
    if (input.action === 'kick' || input.action === 'transfer') {
      const target = await guild.members.fetch(String(input.targetUserId || '')).catch(() => null);
      if (!target || target.voice.channelId !== room.channelId) throw new Error('Member không ở trong phòng.');
      if (target.id === room.ownerId) throw new Error('Không thể chọn host hiện tại.');
      if (input.action === 'kick') {
        store.revokeRoomAccess(room.id, target.id);
        await channel.permissionOverwrites.delete(target.id, 'Thu hồi quyền khi bị kick').catch(() => undefined);
        await target.voice.disconnect(`Dashboard kick by ${input.actorId}`);
        return `Đã kick ${target.user.tag} và thu hồi quyền truy cập.`;
      }
      await this.transferOwnership(room, target, `Chuyển từ Dashboard bởi <@${input.actorId}>.`);
      return `Đã chuyển host cho ${target.user.tag}.`;
    }
    if (input.action === 'delete') {
      store.deleteRoomByChannel(room.channelId);
      await channel.delete(`Dashboard delete by ${input.actorId}`);
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
    const settings = store.getSettings(guild.id, guild.name);
    const creator: CreatorChannelConfig = {
      channelId: channel.id,
      label,
      mode: input.mode,
      ...(parentId ? { categoryId: parentId } : {}),
      ...(input.allowedRoleId ? { allowedRoleId: input.allowedRoleId } : {}),
      notifyJoinLeave: Boolean(input.notifyJoinLeave),
      autoTransferOwner: input.autoTransferOwner !== false,
    };
    store.updateSettings(guild.id, { creatorChannels: [...settings.creatorChannels, creator] });
    return creator;
  }

  async postPaymentPanel(guild: Guild, settings = store.getSettings(guild.id, guild.name)): Promise<string> {
    const channelId = settings.paymentPanelChannelId;
    if (!channelId) return 'Chưa cấu hình kênh payment panel. Dùng `/sgf setup` với option `payment_channel` trước.';
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return 'Kênh payment panel đã cấu hình không còn hợp lệ. Hãy chọn lại bằng `/sgf setup`.';
    const products = store.listProducts(guild.id, true);
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
