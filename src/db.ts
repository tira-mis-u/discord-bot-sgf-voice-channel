import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import type {
  AuthSession,
  CreatorChannelConfig,
  Entitlement,
  GuildSettings,
  OAuthGuild,
  Payment,
  PaymentStatus,
  PaymentType,
  Product,
  Room,
  SessionUser,
} from './types.js';

const dbPath = path.resolve(config.dbFile);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    guild_name TEXT NOT NULL DEFAULT '',
    creator_channels_json TEXT NOT NULL DEFAULT '[]',
    premium_role_id TEXT NOT NULL DEFAULT '',
    control_channel_id TEXT NOT NULL DEFAULT '',
    payment_panel_channel_id TEXT NOT NULL DEFAULT '',
    default_room_category_id TEXT NOT NULL DEFAULT '',
    room_name_template TEXT NOT NULL DEFAULT '{user}''s room',
    donation_min_vnd INTEGER NOT NULL DEFAULT 1000,
    bank_code TEXT NOT NULL DEFAULT '',
    bank_account_number TEXT NOT NULL DEFAULT '',
    bank_account_name TEXT NOT NULL DEFAULT '',
    static_qr_url TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_vnd INTEGER NOT NULL,
    role_id TEXT NOT NULL DEFAULT '',
    duration_days INTEGER NOT NULL DEFAULT 30,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_products_guild ON products(guild_id, active, sort_order);

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    owner_tag TEXT NOT NULL,
    mode TEXT NOT NULL,
    creator_channel_id TEXT NOT NULL,
    control_message_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rooms_guild ON rooms(guild_id);
  CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(guild_id, owner_id);

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    discord_user_tag TEXT NOT NULL,
    type TEXT NOT NULL,
    product_id TEXT NOT NULL DEFAULT '',
    order_code TEXT NOT NULL UNIQUE,
    expected_amount_vnd INTEGER NOT NULL,
    paid_amount_vnd INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    provider_transaction_id TEXT NOT NULL DEFAULT '',
    provider_reference TEXT NOT NULL DEFAULT '',
    transfer_content TEXT NOT NULL DEFAULT '',
    qr_url TEXT NOT NULL DEFAULT '',
    checkout_url TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    paid_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_payments_guild ON payments(guild_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payments_code ON payments(order_code);
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(guild_id, discord_user_id, status);

  CREATE TABLE IF NOT EXISTS payment_events (
    provider_transaction_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    payment_id TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    product_id TEXT NOT NULL DEFAULT '',
    role_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_entitlements_user ON entitlements(guild_id, discord_user_id, status);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_json TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    guilds_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS unmatched_transactions (
    provider_transaction_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToSettings(row: Record<string, unknown>): GuildSettings {
  return {
    guildId: String(row.guild_id),
    guildName: String(row.guild_name || ''),
    creatorChannels: parseJson<CreatorChannelConfig[]>(String(row.creator_channels_json || '[]'), []),
    premiumRoleId: String(row.premium_role_id || ''),
    controlChannelId: String(row.control_channel_id || ''),
    paymentPanelChannelId: String(row.payment_panel_channel_id || ''),
    defaultRoomCategoryId: String(row.default_room_category_id || ''),
    roomNameTemplate: String(row.room_name_template || "{user}'s room"),
    donationMinVnd: Number(row.donation_min_vnd || 1000),
    bankCode: String(row.bank_code || ''),
    bankAccountNumber: String(row.bank_account_number || ''),
    bankAccountName: String(row.bank_account_name || ''),
    staticQrUrl: String(row.static_qr_url || ''),
    updatedAt: String(row.updated_at || ''),
  };
}

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    name: String(row.name),
    description: String(row.description || ''),
    priceVnd: Number(row.price_vnd),
    roleId: String(row.role_id || ''),
    durationDays: Number(row.duration_days || 0),
    active: Boolean(row.active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToRoom(row: Record<string, unknown>): Room {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    ownerId: String(row.owner_id),
    ownerTag: String(row.owner_tag),
    mode: String(row.mode) === 'premium' ? 'premium' : 'free',
    creatorChannelId: String(row.creator_channel_id),
    controlMessageId: String(row.control_message_id || ''),
    createdAt: String(row.created_at),
  };
}

function rowToPayment(row: Record<string, unknown>): Payment {
  return {
    id: String(row.id),
    guildId: String(row.guild_id),
    discordUserId: String(row.discord_user_id),
    discordUserTag: String(row.discord_user_tag),
    type: String(row.type) === 'donation' ? 'donation' : 'product',
    productId: String(row.product_id || ''),
    orderCode: String(row.order_code),
    expectedAmountVnd: Number(row.expected_amount_vnd),
    paidAmountVnd: Number(row.paid_amount_vnd || 0),
    status: String(row.status) as PaymentStatus,
    providerTransactionId: String(row.provider_transaction_id || ''),
    providerReference: String(row.provider_reference || ''),
    transferContent: String(row.transfer_content || ''),
    qrUrl: String(row.qr_url || ''),
    checkoutUrl: String(row.checkout_url || ''),
    note: String(row.note || ''),
    paidAt: String(row.paid_at || ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const store = {
  getSettings(guildId: string, guildName = ''): GuildSettings {
    let row = sqlite.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as Record<string, unknown> | undefined;
    if (!row) {
      const timestamp = now();
      sqlite.prepare(`INSERT INTO guild_settings (guild_id, guild_name, updated_at) VALUES (?, ?, ?)`).run(guildId, guildName, timestamp);
      row = sqlite.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as Record<string, unknown>;
    } else if (guildName && String(row.guild_name || '') !== guildName) {
      sqlite.prepare('UPDATE guild_settings SET guild_name = ?, updated_at = ? WHERE guild_id = ?').run(guildName, now(), guildId);
      row.guild_name = guildName;
    }
    return rowToSettings(row);
  },

  updateSettings(guildId: string, patch: Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>): GuildSettings {
    const current = this.getSettings(guildId);
    const next = { ...current, ...patch, updatedAt: now() };
    sqlite.prepare(`
      UPDATE guild_settings SET
        guild_name = ?, creator_channels_json = ?, premium_role_id = ?, control_channel_id = ?,
        payment_panel_channel_id = ?, default_room_category_id = ?, room_name_template = ?,
        donation_min_vnd = ?, bank_code = ?, bank_account_number = ?, bank_account_name = ?,
        static_qr_url = ?, updated_at = ? WHERE guild_id = ?
    `).run(
      next.guildName,
      JSON.stringify(next.creatorChannels),
      next.premiumRoleId,
      next.controlChannelId,
      next.paymentPanelChannelId,
      next.defaultRoomCategoryId,
      next.roomNameTemplate,
      next.donationMinVnd,
      next.bankCode,
      next.bankAccountNumber,
      next.bankAccountName,
      next.staticQrUrl,
      next.updatedAt,
      guildId,
    );
    return this.getSettings(guildId);
  },

  listProducts(guildId: string, activeOnly = false): Product[] {
    const query = activeOnly
      ? 'SELECT * FROM products WHERE guild_id = ? AND active = 1 ORDER BY sort_order ASC, price_vnd ASC'
      : 'SELECT * FROM products WHERE guild_id = ? ORDER BY sort_order ASC, created_at ASC';
    return (sqlite.prepare(query).all(guildId) as Record<string, unknown>[]).map(rowToProduct);
  },

  getProduct(productId: string): Product | undefined {
    const row = sqlite.prepare('SELECT * FROM products WHERE id = ?').get(productId) as Record<string, unknown> | undefined;
    return row ? rowToProduct(row) : undefined;
  },

  createProduct(input: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>): Product {
    const timestamp = now();
    const productId = id();
    sqlite.prepare(`
      INSERT INTO products (id, guild_id, name, description, price_vnd, role_id, duration_days, active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(productId, input.guildId, input.name, input.description, input.priceVnd, input.roleId, input.durationDays, input.active ? 1 : 0, input.sortOrder, timestamp, timestamp);
    return this.getProduct(productId)!;
  },

  updateProduct(productId: string, patch: Partial<Omit<Product, 'id' | 'guildId' | 'createdAt' | 'updatedAt'>>): Product | undefined {
    const current = this.getProduct(productId);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: now() };
    sqlite.prepare(`
      UPDATE products SET name = ?, description = ?, price_vnd = ?, role_id = ?, duration_days = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?
    `).run(next.name, next.description, next.priceVnd, next.roleId, next.durationDays, next.active ? 1 : 0, next.sortOrder, next.updatedAt, productId);
    return this.getProduct(productId);
  },

  deleteProduct(productId: string): void {
    sqlite.prepare('DELETE FROM products WHERE id = ?').run(productId);
  },

  insertRoom(input: Omit<Room, 'id' | 'createdAt'>): Room {
    const timestamp = now();
    const roomId = id();
    sqlite.prepare(`
      INSERT INTO rooms (id, guild_id, channel_id, owner_id, owner_tag, mode, creator_channel_id, control_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, input.guildId, input.channelId, input.ownerId, input.ownerTag, input.mode, input.creatorChannelId, input.controlMessageId, timestamp);
    return this.getRoomByChannel(input.channelId)!;
  },

  updateRoom(channelId: string, patch: Partial<Pick<Room, 'controlMessageId' | 'ownerId' | 'ownerTag' | 'mode'>>): Room | undefined {
    const current = this.getRoomByChannel(channelId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    sqlite.prepare('UPDATE rooms SET owner_id = ?, owner_tag = ?, mode = ?, control_message_id = ? WHERE channel_id = ?').run(next.ownerId, next.ownerTag, next.mode, next.controlMessageId, channelId);
    return this.getRoomByChannel(channelId);
  },

  getRoomByChannel(channelId: string): Room | undefined {
    const row = sqlite.prepare('SELECT * FROM rooms WHERE channel_id = ?').get(channelId) as Record<string, unknown> | undefined;
    return row ? rowToRoom(row) : undefined;
  },

  getRoomByOwner(guildId: string, ownerId: string): Room | undefined {
    const row = sqlite.prepare('SELECT * FROM rooms WHERE guild_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1').get(guildId, ownerId) as Record<string, unknown> | undefined;
    return row ? rowToRoom(row) : undefined;
  },

  listRooms(guildId: string): Room[] {
    return (sqlite.prepare('SELECT * FROM rooms WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) as Record<string, unknown>[]).map(rowToRoom);
  },

  deleteRoomByChannel(channelId: string): void {
    sqlite.prepare('DELETE FROM rooms WHERE channel_id = ?').run(channelId);
  },

  createPayment(input: {
    guildId: string;
    discordUserId: string;
    discordUserTag: string;
    type: PaymentType;
    productId?: string;
    orderCode: string;
    expectedAmountVnd: number;
    qrUrl: string;
    checkoutUrl: string;
    note?: string;
  }): Payment {
    const timestamp = now();
    const paymentId = id();
    sqlite.prepare(`
      INSERT INTO payments (id, guild_id, discord_user_id, discord_user_tag, type, product_id, order_code, expected_amount_vnd, qr_url, checkout_url, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(paymentId, input.guildId, input.discordUserId, input.discordUserTag, input.type, input.productId || '', input.orderCode, input.expectedAmountVnd, input.qrUrl, input.checkoutUrl, input.note || '', timestamp, timestamp);
    return this.getPayment(paymentId)!;
  },

  getPayment(paymentId: string): Payment | undefined {
    const row = sqlite.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as Record<string, unknown> | undefined;
    return row ? rowToPayment(row) : undefined;
  },

  getPaymentByCode(orderCode: string): Payment | undefined {
    const row = sqlite.prepare('SELECT * FROM payments WHERE order_code = ?').get(orderCode) as Record<string, unknown> | undefined;
    return row ? rowToPayment(row) : undefined;
  },

  getPaymentByProviderTransaction(providerTransactionId: string): Payment | undefined {
    const row = sqlite.prepare('SELECT * FROM payments WHERE provider_transaction_id = ?').get(providerTransactionId) as Record<string, unknown> | undefined;
    return row ? rowToPayment(row) : undefined;
  },

  updatePaymentCheckout(paymentId: string, checkoutUrl: string): void {
    sqlite.prepare('UPDATE payments SET checkout_url = ?, updated_at = ? WHERE id = ?').run(checkoutUrl, now(), paymentId);
  },

  listPayments(guildId: string, limit = 100): Payment[] {
    return (sqlite.prepare('SELECT * FROM payments WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?').all(guildId, Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[]).map(rowToPayment);
  },

  getPaidUserSummary(guildId: string): Record<string, { paidCount: number; paidTotalVnd: number; lastPaidAt: string }> {
    const rows = sqlite.prepare("SELECT discord_user_id, COUNT(*) AS paid_count, COALESCE(SUM(paid_amount_vnd), 0) AS paid_total, MAX(paid_at) AS last_paid_at FROM payments WHERE guild_id = ? AND status = 'paid' GROUP BY discord_user_id").all(guildId) as Record<string, unknown>[];
    return Object.fromEntries(rows.map((row) => [String(row.discord_user_id), { paidCount: Number(row.paid_count || 0), paidTotalVnd: Number(row.paid_total || 0), lastPaidAt: String(row.last_paid_at || '') }]));
  },


  listUserPayments(guildId: string, userId: string, limit = 50): Payment[] {
    return (sqlite.prepare('SELECT * FROM payments WHERE guild_id = ? AND discord_user_id = ? ORDER BY created_at DESC LIMIT ?').all(guildId, userId, limit) as Record<string, unknown>[]).map(rowToPayment);
  },

  recordPaymentEvent(providerTransactionId: string, payload: unknown, paymentId = ''): boolean {
    try {
      sqlite.prepare('INSERT INTO payment_events (provider_transaction_id, payload_json, payment_id, received_at) VALUES (?, ?, ?, ?)').run(providerTransactionId, JSON.stringify(payload), paymentId, now());
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return false;
      throw error;
    }
  },

  saveUnmatchedTransaction(providerTransactionId: string, payload: unknown): void {
    sqlite.prepare(`INSERT INTO unmatched_transactions (provider_transaction_id, payload_json, received_at) VALUES (?, ?, ?) ON CONFLICT(provider_transaction_id) DO UPDATE SET payload_json = excluded.payload_json`).run(providerTransactionId, JSON.stringify(payload), now());
  },

  markPaymentPaid(paymentId: string, input: { amount: number; providerTransactionId: string; providerReference: string; transferContent: string }): Payment | undefined {
    const timestamp = now();
    sqlite.prepare(`
      UPDATE payments SET status = 'paid', paid_amount_vnd = ?, provider_transaction_id = ?, provider_reference = ?, transfer_content = ?, paid_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(input.amount, input.providerTransactionId, input.providerReference, input.transferContent, timestamp, timestamp, paymentId);
    return this.getPayment(paymentId);
  },

  getEntitlement(guildId: string, userId: string, productId = ''): Entitlement | undefined {
    const query = productId
      ? 'SELECT * FROM entitlements WHERE guild_id = ? AND discord_user_id = ? AND product_id = ? AND status = \'active\' ORDER BY created_at DESC LIMIT 1'
      : 'SELECT * FROM entitlements WHERE guild_id = ? AND discord_user_id = ? AND status = \'active\' ORDER BY created_at DESC LIMIT 1';
    const row = (productId ? sqlite.prepare(query).get(guildId, userId, productId) : sqlite.prepare(query).get(guildId, userId)) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const expiresAt = String(row.expires_at || '');
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      sqlite.prepare('UPDATE entitlements SET status = \'expired\', updated_at = ? WHERE id = ?').run(now(), row.id);
      return undefined;
    }
    return {
      id: String(row.id), guildId: String(row.guild_id), discordUserId: String(row.discord_user_id), productId: String(row.product_id || ''), roleId: String(row.role_id), paymentId: String(row.payment_id), status: String(row.status) as Entitlement['status'], expiresAt, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  },

  listEntitlements(guildId: string, userId?: string): Entitlement[] {
    const rows = (userId
      ? sqlite.prepare('SELECT * FROM entitlements WHERE guild_id = ? AND discord_user_id = ? ORDER BY created_at DESC').all(guildId, userId)
      : sqlite.prepare('SELECT * FROM entitlements WHERE guild_id = ? ORDER BY created_at DESC').all(guildId)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id), guildId: String(row.guild_id), discordUserId: String(row.discord_user_id), productId: String(row.product_id || ''), roleId: String(row.role_id), paymentId: String(row.payment_id), status: String(row.status) as Entitlement['status'], expiresAt: String(row.expires_at || ''), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  },

  upsertEntitlement(input: { guildId: string; discordUserId: string; productId: string; roleId: string; paymentId: string; expiresAt: string }): Entitlement {
    const existing = this.getEntitlement(input.guildId, input.discordUserId, input.productId);
    const timestamp = now();
    if (existing) {
      sqlite.prepare('UPDATE entitlements SET role_id = ?, payment_id = ?, status = \'active\', expires_at = ?, updated_at = ? WHERE id = ?').run(input.roleId, input.paymentId, input.expiresAt, timestamp, existing.id);
      return this.listEntitlements(input.guildId, input.discordUserId).find((item) => item.id === existing.id)!;
    }
    const entitlementId = id();
    sqlite.prepare(`INSERT INTO entitlements (id, guild_id, discord_user_id, product_id, role_id, payment_id, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(entitlementId, input.guildId, input.discordUserId, input.productId, input.roleId, input.paymentId, input.expiresAt, timestamp, timestamp);
    return this.listEntitlements(input.guildId, input.discordUserId).find((item) => item.id === entitlementId)!;
  },

  hasActiveEntitlement(guildId: string, userId: string): boolean {
    return Boolean(this.getEntitlement(guildId, userId));
  },

  hasActiveEntitlementForRole(guildId: string, userId: string, roleId: string): boolean {
    const row = sqlite.prepare("SELECT id FROM entitlements WHERE guild_id = ? AND discord_user_id = ? AND role_id = ? AND status = 'active' AND (expires_at = '' OR expires_at > ?) LIMIT 1").get(guildId, userId, roleId, now());
    return Boolean(row);
  },

  expireDueEntitlements(): Entitlement[] {
    const timestamp = now();
    const rows = sqlite.prepare("SELECT * FROM entitlements WHERE status = 'active' AND expires_at <> '' AND expires_at <= ?").all(timestamp) as Record<string, unknown>[];
    if (rows.length) sqlite.prepare("UPDATE entitlements SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at <> '' AND expires_at <= ?").run(timestamp, timestamp);
    return rows.map((row) => ({
      id: String(row.id), guildId: String(row.guild_id), discordUserId: String(row.discord_user_id), productId: String(row.product_id || ''), roleId: String(row.role_id), paymentId: String(row.payment_id), status: 'expired', expiresAt: String(row.expires_at || ''), createdAt: String(row.created_at), updatedAt: timestamp,
    }));
  },

  getStats(guildId: string): { paidTotalVnd: number; paidCount: number; pendingCount: number; donorCount: number; activeRooms: number } {
    const row = sqlite.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN paid_amount_vnd ELSE 0 END), 0) AS paid_total, COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_count, COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count, COUNT(DISTINCT CASE WHEN status = 'paid' THEN discord_user_id END) AS donor_count FROM payments WHERE guild_id = ?`).get(guildId) as Record<string, unknown>;
    const activeRooms = Number((sqlite.prepare('SELECT COUNT(*) AS count FROM rooms WHERE guild_id = ?').get(guildId) as Record<string, unknown>).count || 0);
    return { paidTotalVnd: Number(row.paid_total || 0), paidCount: Number(row.paid_count || 0), pendingCount: Number(row.pending_count || 0), donorCount: Number(row.donor_count || 0), activeRooms };
  },

  createSession(input: { user: SessionUser; accessToken: string; refreshToken: string; expiresAt: number; guilds: OAuthGuild[] }): AuthSession {
    const sessionId = crypto.randomBytes(32).toString('hex');
    sqlite.prepare('INSERT INTO sessions (id, user_json, access_token, refresh_token, expires_at, guilds_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sessionId, JSON.stringify(input.user), input.accessToken, input.refreshToken, input.expiresAt, JSON.stringify(input.guilds), now());
    return { id: sessionId, ...input };
  },

  getSession(sessionId: string): AuthSession | undefined {
    const row = sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: String(row.id), user: parseJson<SessionUser>(String(row.user_json), { id: '', username: '' }), accessToken: String(row.access_token), refreshToken: String(row.refresh_token || ''), expiresAt: Number(row.expires_at), guilds: parseJson<OAuthGuild[]>(String(row.guilds_json || '[]'), []) };
  },

  updateSession(sessionId: string, input: Partial<Pick<AuthSession, 'accessToken' | 'refreshToken' | 'expiresAt' | 'guilds'>>): AuthSession | undefined {
    const current = this.getSession(sessionId);
    if (!current) return undefined;
    const next = { ...current, ...input };
    sqlite.prepare('UPDATE sessions SET access_token = ?, refresh_token = ?, expires_at = ?, guilds_json = ? WHERE id = ?').run(next.accessToken, next.refreshToken, next.expiresAt, JSON.stringify(next.guilds), sessionId);
    return this.getSession(sessionId);
  },

  deleteSession(sessionId: string): void {
    sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  },
};


export { sqlite };
