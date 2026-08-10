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
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type VoiceState,
} from 'discord.js';
import { config } from './config.js';
import { store } from './db.js';
import type { CreatorChannelConfig, GuildSettings, Room } from './types.js';
import type { PaymentCreationResult } from './services/payment-service.js';
import { formatVnd, safeSlug } from './utils.js';
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

export class SgfBot {
  public readonly client: Client;
  private readonly creatingOwners = new Set<string>();
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
    return {
      online: this.client.isReady(),
      userTag: this.client.user?.tag || '',
      guildCount: this.client.guilds.cache.size,
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
      await this.registerSlashCommand();
      await this.expireDueEntitlements();
      this.expiryTimer = setInterval(() => void this.expireDueEntitlements(), 60_000);
    });
    this.client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
      await this.onVoiceStateUpdate(oldState, newState);
    });
    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        await this.onInteraction(interaction);
      } catch (error) {
        console.error('[bot] interaction error', error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Có lỗi xảy ra, thử lại sau nhé.', ephemeral: true }).catch(() => undefined);
        }
      }
    });
    this.client.on(Events.ChannelDelete, (channel) => {
      store.deleteRoomByChannel(channel.id);
    });
  }

  private async registerSlashCommand(): Promise<void> {
    const command = new SlashCommandBuilder()
      .setName('sgf')
      .setDescription('Voice room, Premium và thanh toán SGF')
      .addSubcommand((subcommand) => subcommand.setName('setup').setDescription('Admin: lấy link cấu hình và webhook'))
      .addSubcommand((subcommand) => subcommand.setName('panel').setDescription('Admin: đăng panel mua role và donate'))
      .addSubcommand((subcommand) => subcommand.setName('status').setDescription('Admin: xem trạng thái bot/server'))
      .addSubcommand((subcommand) => subcommand.setName('sync').setDescription('Admin: đồng bộ lại slash command'))
      .addSubcommand((subcommand) => subcommand.setName('premium').setDescription('Mở menu mua Premium và donate'))
      .addSubcommand((subcommand) => subcommand.setName('room').setDescription('Mở control panel phòng voice của bạn'))
      .addSubcommand((subcommand) => subcommand.setName('help').setDescription('Xem hướng dẫn dùng bot'));

    for (const guild of this.client.guilds.cache.values()) {
      await guild.commands.set([command.toJSON()]).catch((error) => {
        this.lastError = error instanceof Error ? error.message : `Cannot register slash command for ${guild.id}`;
        console.error(`[bot] cannot register command for ${guild.id}`, error);
      });
    }
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) return this.onSlash(interaction);
    if (interaction.isButton()) return this.onButton(interaction);
    if (interaction.isModalSubmit()) return this.onModal(interaction);
  }

  private async onSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== 'sgf' || !interaction.guild) return;
    const subcommand = interaction.options.getSubcommand();
    const adminOnly = ['setup', 'panel', 'status', 'sync'].includes(subcommand);
    if (adminOnly && !isAdmin(interaction)) {
      await interaction.reply({ content: 'Lệnh này chỉ dành cho admin server.', ephemeral: true });
      return;
    }

    const settings = store.getSettings(interaction.guild.id, interaction.guild.name);
    if (subcommand === 'help') {
      await interaction.reply({
        content: [
          '**SGF Bot commands**',
          '• `/sgf premium` — mở menu mua Premium/donate',
          '• `/sgf room` — mở control panel phòng của bạn',
          '• `/sgf help` — xem hướng dẫn này',
          '• Admin: `/sgf setup`, `/sgf panel`, `/sgf status`, `/sgf sync`',
          '• Hoặc click trực tiếp vào creator voice channel để tạo phòng.',
        ].join('\n'),
        ephemeral: true,
      });
      return;
    }
    if (subcommand === 'premium') {
      const products = store.listProducts(interaction.guild.id, true);
      const row = this.paymentButtonRow(products);
      const embed = new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('💎 SGF Premium & Donate')
        .setDescription(products.length ? 'Chọn gói bên dưới để nhận QR thanh toán riêng. Webhook SePay sẽ tự cấp role sau khi thanh toán.' : `Admin chưa tạo gói. Mở dashboard: ${config.publicUrl}`);
      await interaction.reply({ ephemeral: true, embeds: [embed], components: row ? [row] : [] });
      return;
    }
    if (subcommand === 'room') {
      const room = store.getRoomByOwner(interaction.guild.id, interaction.user.id);
      if (!room) {
        await interaction.reply({ content: 'Bạn chưa có phòng tạm. Hãy click vào creator voice channel trước.', ephemeral: true });
        return;
      }
      const row = this.roomButtonRow(room);
      await interaction.reply({ content: `Control panel cho <#${room.channelId}>`, components: [row], ephemeral: true });
      return;
    }
    if (subcommand === 'setup') {
      const setupRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel('Mở Dashboard').setStyle(ButtonStyle.Link).setURL(config.publicUrl),
        new ButtonBuilder().setLabel('SePay webhook docs').setStyle(ButtonStyle.Link).setURL('https://developer.sepay.vn/vi/sepay-webhooks/tao-qr-va-form-thanh-toan'),
      );
      await interaction.reply({
        content: [
          '✅ SGF Bot đã sẵn sàng.',
          `Dashboard: ${config.publicUrl}`,
          'Vào Dashboard → chọn server → cấu hình voice, role Premium, giá gói và kênh panel.',
          `Webhook SePay: ${config.publicUrl}/api/payments/sepay/webhook`,
          'Nếu không thấy slash command, dùng `/sgf sync` hoặc invite lại bot với scope `applications.commands`.',
        ].join('\n'),
        components: [setupRow],
        ephemeral: true,
      });
      return;
    }
    if (subcommand === 'panel') {
      const result = await this.postPaymentPanel(interaction.guild, settings);
      await interaction.reply({ content: result, ephemeral: true });
      return;
    }
    if (subcommand === 'sync') {
      await this.registerSlashCommand();
      await interaction.reply({ content: `Đã sync slash command cho ${this.client.guilds.cache.size} server. Hãy gõ lại \/sgf.`, ephemeral: true });
      return;
    }
    const stats = store.getStats(interaction.guild.id);
    await interaction.reply({
      content: `Bot ${this.client.isReady() ? 'online' : 'offline'}. Phòng tạm: ${stats.activeRooms} · Đã thanh toán: ${stats.paidCount} · Tổng: ${formatVnd(stats.paidTotalVnd)} · Dashboard: ${config.publicUrl}`,
      ephemeral: true,
    });
  }

  private async onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const member = newState.member;
    if (!member || member.user.bot || !newState.guild) return;

    if (newState.channelId && newState.channelId !== oldState.channelId) {
      const settings = store.getSettings(newState.guild.id, newState.guild.name);
      const creator = settings.creatorChannels.find((item) => item.channelId === newState.channelId);
      if (creator) await this.createRoomFromTrigger(member, creator, settings, oldState.channelId);
    }

    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      await this.removeRoomIfEmpty(oldState.channelId);
    }
  }

  private async createRoomFromTrigger(member: GuildMember, creator: CreatorChannelConfig, settings: GuildSettings, previousChannelId: string | null): Promise<void> {
    const key = `${member.guild.id}:${member.id}`;
    if (this.creatingOwners.has(key)) return;
    this.creatingOwners.add(key);
    try {
      const premium = this.isPremium(member, settings);
      if (creator.mode === 'premium' && !premium) {
        await member.send('Phòng này dành cho Premium. Bạn có thể mua gói trong panel thanh toán của server.').catch(() => undefined);
        if (previousChannelId) await member.voice.setChannel(previousChannelId, 'Chưa có Premium để dùng creator channel').catch(() => undefined);
        else await member.voice.disconnect('Chưa có Premium để dùng creator channel').catch(() => undefined);
        return;
      }

      const existing = store.getRoomByOwner(member.guild.id, member.id);
      if (existing) {
        const oldRoom = member.guild.channels.cache.get(existing.channelId);
        if (oldRoom?.isVoiceBased()) {
          if (creator.mode === 'premium' && existing.mode === 'free') {
            const upgraded = store.updateRoom(existing.channelId, { mode: 'premium' });
            if (upgraded) {
              const panelId = await this.sendRoomControlPanel(member.guild, upgraded, settings);
              store.updateRoom(existing.channelId, { controlMessageId: panelId });
            }
          }
          await member.voice.setChannel(oldRoom, 'Dùng lại phòng tạm đang có').catch(() => undefined);
          return;
        }
        store.deleteRoomByChannel(existing.channelId);
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

      const room = store.insertRoom({ guildId: member.guild.id, channelId: channel.id, ownerId: member.id, ownerTag: member.user.tag, mode: creator.mode, creatorChannelId: creator.channelId, controlMessageId: '' });
      const controlMessageId = await this.sendRoomControlPanel(member.guild, room, settings);
      store.updateRoom(channel.id, { controlMessageId });
      await member.voice.setChannel(channel, 'SGF tạo phòng tạm').catch(async () => {
        await channel.delete('Không move được chủ phòng').catch(() => undefined);
        store.deleteRoomByChannel(channel.id);
      });
    } finally {
      this.creatingOwners.delete(key);
    }
  }

  private async expireDueEntitlements(): Promise<void> {
    const due = store.expireDueEntitlements();
    for (const entitlement of due) {
      const guild = this.client.guilds.cache.get(entitlement.guildId);
      if (!guild) continue;
      const member = await guild.members.fetch(entitlement.discordUserId).catch(() => null);
      if (!member || store.hasActiveEntitlementForRole(entitlement.guildId, entitlement.discordUserId, entitlement.roleId)) continue;
      await member.roles.remove(entitlement.roleId, 'SGF Premium entitlement expired').catch(() => undefined);
    }
  }

  private isPremium(member: GuildMember, settings: GuildSettings): boolean {
    if (store.hasActiveEntitlement(member.guild.id, member.id)) return true;
    return Boolean(settings.premiumRoleId && member.roles.cache.has(settings.premiumRoleId));
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

  private roomButtonRow(room: Room): ActionRowBuilder<ButtonBuilder> {
    const premium = room.mode === 'premium';
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`room:rename:${room.channelId}`).setLabel('Đổi tên').setEmoji('✏️').setStyle(ButtonStyle.Secondary).setDisabled(!premium),
      new ButtonBuilder().setCustomId(`room:limit:${room.channelId}`).setLabel('Giới hạn').setEmoji('👥').setStyle(ButtonStyle.Secondary).setDisabled(!premium),
      new ButtonBuilder().setCustomId(`room:lock:${room.channelId}`).setLabel('Khóa/mở').setEmoji('🔒').setStyle(ButtonStyle.Secondary).setDisabled(!premium),
      new ButtonBuilder().setCustomId(`room:hide:${room.channelId}`).setLabel('Ẩn/hiện').setEmoji('🙈').setStyle(ButtonStyle.Secondary).setDisabled(!premium),
      new ButtonBuilder().setCustomId(`room:delete:${room.channelId}`).setLabel('Xóa').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    );
  }

  private paymentButtonRow(products: ReturnType<typeof store.listProducts>): ActionRowBuilder<ButtonBuilder> | undefined {
    if (!products.length) return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('pay:donate:x').setLabel('Donate').setEmoji('☕').setStyle(ButtonStyle.Success));
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const product of products.slice(0, 4)) {
      row.addComponents(new ButtonBuilder().setCustomId(`pay:buy:${product.id}`).setLabel(`${product.name} · ${formatVnd(product.priceVnd)}`).setStyle(ButtonStyle.Primary));
    }
    row.addComponents(new ButtonBuilder().setCustomId('pay:donate:x').setLabel('Donate').setEmoji('☕').setStyle(ButtonStyle.Success));
    return row;
  }

  private async sendRoomControlPanel(guild: Guild, room: Room, settings: GuildSettings): Promise<string> {
    const channelId = settings.controlChannelId || settings.paymentPanelChannelId || guild.systemChannelId;
    if (!channelId) return '';
    const controlChannel = guild.channels.cache.get(channelId);
    if (!controlChannel?.isTextBased()) return '';
    const premium = room.mode === 'premium';
    const embed = new EmbedBuilder()
      .setColor(premium ? 0x9b7bff : 0x5f6b7a)
      .setTitle(premium ? '💎 Phòng Premium' : '🔊 Phòng tạm')
      .setDescription(`Phòng: <#${room.channelId}>\nChủ phòng: <@${room.ownerId}>\nChế độ: ${premium ? 'Tạo + chỉnh sửa' : 'Chỉ tạo phòng'}\n\n${premium ? 'Dùng các nút ngay bên dưới, không cần gọi thêm slash command.' : 'Gói miễn phí chỉ tạo phòng; mua Premium để đổi tên, giới hạn, khóa hoặc ẩn phòng.'}`)
      .setFooter({ text: 'Phòng sẽ tự xóa khi không còn người.' });
    const buttons = this.roomButtonRow(room);
    const message = await controlChannel.send({ embeds: [embed], components: [buttons] });
    return message.id;
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const [namespace, action, value] = interaction.customId.split(':');
    if (namespace === 'room') return this.onRoomButton(interaction, action, value);
    if (namespace === 'pay') return this.onPaymentButton(interaction, action, value);
  }

  private async onRoomButton(interaction: ButtonInteraction, action: string, channelId: string): Promise<void> {
    const room = store.getRoomByChannel(channelId);
    if (!room || !interaction.guild) {
      await interaction.reply({ content: 'Phòng này không còn tồn tại.', ephemeral: true });
      return;
    }
    const isOwner = interaction.user.id === room.ownerId;
    const admin = isAdmin(interaction);
    if (!isOwner && !admin) {
      await interaction.reply({ content: 'Chỉ chủ phòng hoặc admin mới dùng được bảng này.', ephemeral: true });
      return;
    }
    if (action !== 'delete' && room.mode !== 'premium') {
      await interaction.reply({ content: 'Phòng miễn phí chỉ hỗ trợ tạo phòng. Mua Premium để mở tính năng chỉnh sửa.', ephemeral: true });
      return;
    }
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      store.deleteRoomByChannel(channelId);
      await interaction.reply({ content: 'Kênh đã bị xóa.', ephemeral: true });
      return;
    }
    if (action === 'rename') {
      const modal = new ModalBuilder().setCustomId(`roommodal:rename:${channelId}`).setTitle('Đổi tên phòng');
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Tên mới').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(channel.name)));
      await interaction.showModal(modal);
      return;
    }
    if (action === 'limit') {
      const modal = new ModalBuilder().setCustomId(`roommodal:limit:${channelId}`).setTitle('Giới hạn thành viên');
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('limit').setLabel('Nhập 0 để bỏ giới hạn, tối đa 99').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(channel.userLimit || 0))));
      await interaction.showModal(modal);
      return;
    }
    if (action === 'lock') {
      const everyone = interaction.guild.roles.everyone;
      const locked = channel.permissionOverwrites.cache.get(everyone.id)?.deny.has('Connect');
      await channel.permissionOverwrites.edit(everyone, { Connect: locked ? null : false });
      await channel.permissionOverwrites.edit(room.ownerId, { Connect: true, ViewChannel: true });
      await interaction.reply({ content: locked ? '🔓 Đã mở khóa phòng.' : '🔒 Đã khóa phòng với người ngoài.', ephemeral: true });
      return;
    }
    if (action === 'hide') {
      const everyone = interaction.guild.roles.everyone;
      const hidden = channel.permissionOverwrites.cache.get(everyone.id)?.deny.has('ViewChannel');
      await channel.permissionOverwrites.edit(everyone, { ViewChannel: hidden ? null : false });
      await channel.permissionOverwrites.edit(room.ownerId, { ViewChannel: true, Connect: true });
      await interaction.reply({ content: hidden ? '👁️ Đã hiện phòng.' : '🙈 Đã ẩn phòng khỏi thành viên khác.', ephemeral: true });
      return;
    }
    if (action === 'delete') {
      store.deleteRoomByChannel(channelId);
      await channel.delete('Chủ phòng xóa phòng tạm').catch(() => undefined);
      await interaction.reply({ content: '🗑️ Đã xóa phòng.', ephemeral: true });
    }
  }

  private async onModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [namespace, action, channelId] = interaction.customId.split(':');
    if (namespace === 'payment') return this.onDonationModal(interaction);
    if (namespace !== 'roommodal' || !interaction.guild) return;
    const room = store.getRoomByChannel(channelId);
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!room || !channel?.isVoiceBased()) {
      await interaction.reply({ content: 'Phòng không còn tồn tại.', ephemeral: true });
      return;
    }
    if (interaction.user.id !== room.ownerId && !isAdmin(interaction)) {
      await interaction.reply({ content: 'Chỉ chủ phòng hoặc admin mới thao tác được.', ephemeral: true });
      return;
    }
    if (action === 'rename') {
      const name = interaction.fields.getTextInputValue('name').trim().slice(0, 100);
      await channel.setName(name, 'Đổi tên bởi chủ phòng');
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
      await channel.setUserLimit(limit, 'Đổi giới hạn bởi chủ phòng');
      await interaction.reply({ content: `👥 Đã đặt giới hạn: **${limit === 0 ? 'Không giới hạn' : limit}**.`, ephemeral: true });
    }
  }

  private async onPaymentButton(interaction: ButtonInteraction, action: string, productId?: string): Promise<void> {
    if (!interaction.guild) return;
    if (action === 'donate') {
      const modal = new ModalBuilder().setCustomId('payment:donate').setTitle('Donate cho SGF');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Số tiền VND, ví dụ 50000').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)),
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('note').setLabel('Lời nhắn (không bắt buộc)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(200)),
      );
      await interaction.showModal(modal);
      return;
    }
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
      'Webhook SePay sẽ tự cấp role sau khi nhận đúng giao dịch.',
    ].filter(Boolean).join('\n');
    const embed = new EmbedBuilder().setColor(0x2dd4bf).setTitle('💳 Đơn thanh toán SGF').setDescription(lines).setFooter({ text: `Mã đơn ${payment.orderCode}` });
    if (payment.qrUrl) embed.setImage(payment.qrUrl);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel('Mở trang thanh toán').setStyle(ButtonStyle.Link).setURL(payment.checkoutUrl));
    return { content: 'Đây là tin nhắn riêng chỉ bạn nhìn thấy.', embeds: [embed], components: [row] };
  }

  async listGuildMembers(guildId: string): Promise<Array<{ id: string; username: string; globalName: string; displayName: string; avatarUrl: string; bot: boolean; joinedAt: string; roleIds: string[] }>> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Bot chưa ở trong server.');
    const members = await guild.members.fetch();
    return [...members.values()].map((member) => ({
      id: member.id,
      username: member.user.username,
      globalName: member.user.globalName || '',
      displayName: member.displayName,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 64 }),
      bot: member.user.bot,
      joinedAt: member.joinedAt?.toISOString() || '',
      roleIds: [...member.roles.cache.keys()].filter((roleId) => roleId !== guild.id),
    }));
  }

  async createCreatorChannel(guild: Guild, input: { label: string; mode: 'free' | 'premium'; categoryId?: string }): Promise<CreatorChannelConfig> {
    const label = input.label.trim().slice(0, 100) || 'Tạo phòng';
    let parentId = input.categoryId || '';
    if (parentId) {
      const parent = guild.channels.cache.get(parentId);
      if (!parent || parent.type !== ChannelType.GuildCategory) throw new Error('Category ID không hợp lệ hoặc bot không thấy category.');
    } else {
      parentId = '';
    }
    const channel = await guild.channels.create({ name: label, type: ChannelType.GuildVoice, parent: parentId || undefined, reason: `SGF create ${input.mode} creator channel` });
    const settings = store.getSettings(guild.id, guild.name);
    const creator: CreatorChannelConfig = { channelId: channel.id, label, mode: input.mode, ...(parentId ? { categoryId: parentId } : {}) };
    store.updateSettings(guild.id, { creatorChannels: [...settings.creatorChannels, creator] });
    return creator;
  }

  async postPaymentPanel(guild: Guild, settings = store.getSettings(guild.id, guild.name)): Promise<string> {
    const channelId = settings.paymentPanelChannelId || settings.controlChannelId || guild.systemChannelId;
    if (!channelId) return 'Chưa cấu hình kênh panel.';
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return 'Payment panel channel không phải kênh text hoặc bot không thấy kênh.';
    const products = store.listProducts(guild.id, true);
    const embed = new EmbedBuilder().setColor(0x8b5cf6).setTitle('💎 SGF Premium & Donate').setDescription('Mua role Premium để mở phòng voice có quyền chỉnh sửa. Hoặc donate để ủng hộ SGF. Sau khi chuyển khoản, hệ thống tự xác nhận qua SePay.');
    const buttons = this.paymentButtonRow(products)!;
    await channel.send({ embeds: [embed], components: [buttons] });
    return `Đã đăng payment panel vào <#${channel.id}>${products.length > 4 ? ' (4 gói đầu; dashboard có thể làm panel riêng)' : ''}.`;
  }

  async handleSepayWebhook(payload: import('./types.js').SepayWebhookPayload): Promise<ReturnType<typeof settleSepayWebhook>> {
    return settleSepayWebhook(this.client, payload);
  }
}
