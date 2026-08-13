import crypto from 'node:crypto';
import postgres from 'postgres';
import { config } from '../config.js';
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
} from '../types.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value || '');

const sql = postgres(config.databaseUrl || 'postgres://localhost/unused', {
  max: Number(process.env.POSTGRES_POOL_MAX || 10),
  idle_timeout: 20,
  connect_timeout: 15,
  ssl: config.databaseUrl.includes('localhost') ? false : 'require',
  prepare: false,
  transform: { undefined: null },
});

function rowToSettings(row: Record<string, unknown>, creatorChannels: CreatorChannelConfig[]): GuildSettings {
  return {
    guildId: String(row.guild_id),
    guildName: String(row.guild_name || ''),
    creatorChannels,
    premiumRoleId: String(row.premium_role_id || ''),
    controlChannelId: String(row.control_channel_id || ''),
    paymentPanelChannelId: String(row.payment_panel_channel_id || ''),
    defaultRoomCategoryId: String(row.default_room_category_id || ''),
    roomNameTemplate: String(row.room_name_template || "{user}'s room"),
    donationMinVnd: Number(row.donation_min_vnd || 1000),
    sepayBankAccountId: String(row.sepay_bank_account_id || ''),
    bankCode: String(row.bank_code || ''),
    bankAccountNumber: String(row.bank_account_number || ''),
    bankAccountName: String(row.bank_account_name || ''),
    staticQrUrl: String(row.static_qr_url || ''),
    updatedAt: iso(row.updated_at),
  };
}

function rowToCreator(row: Record<string, unknown>): CreatorChannelConfig {
  return {
    channelId: String(row.channel_id),
    label: String(row.label || 'Tạo phòng'),
    mode: String(row.mode) === 'basic' ? 'basic' : 'editable',
    ...(row.category_id ? { categoryId: String(row.category_id) } : {}),
    ...(row.allowed_role_id ? { allowedRoleId: String(row.allowed_role_id) } : {}),
    notifyJoinLeave: Boolean(row.notify_join_leave),
    autoTransferOwner: row.auto_transfer_owner !== false,
  };
}

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: String(row.id), guildId: String(row.guild_id), name: String(row.name), description: String(row.description || ''),
    priceVnd: Number(row.price_vnd), roleId: String(row.role_id || ''), durationDays: Number(row.duration_days || 30),
    active: Boolean(row.active), sortOrder: Number(row.sort_order || 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function rowToRoom(row: Record<string, unknown>): Room {
  return {
    id: String(row.id), guildId: String(row.guild_id), channelId: String(row.channel_id), ownerId: String(row.owner_id),
    ownerTag: String(row.owner_tag), originalOwnerId: String(row.original_owner_id || row.owner_id || ''), mode: String(row.mode) === 'basic' ? 'basic' : 'editable', creatorChannelId: String(row.creator_channel_id),
    controlMessageId: String(row.control_message_id || ''), notifyJoinLeave: Boolean(row.notify_join_leave), passwordHash: String(row.password_hash || ''),
    passwordSalt: String(row.password_salt || ''), createdAt: iso(row.created_at),
  };
}

function rowToPayment(row: Record<string, unknown>): Payment {
  return {
    id: String(row.id), guildId: String(row.guild_id), discordUserId: String(row.discord_user_id), discordUserTag: String(row.discord_user_tag),
    type: String(row.type) === 'donation' ? 'donation' : 'product', productId: String(row.product_id || ''), orderCode: String(row.order_code),
    expectedAmountVnd: Number(row.expected_amount_vnd), paidAmountVnd: Number(row.paid_amount_vnd || 0), status: String(row.status) as PaymentStatus,
    providerTransactionId: String(row.provider_transaction_id || ''), providerReference: String(row.provider_reference || ''),
    transferContent: String(row.transfer_content || ''), qrUrl: String(row.qr_url || ''), checkoutUrl: String(row.checkout_url || ''),
    note: String(row.note || ''), paidAt: iso(row.paid_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function rowToEntitlement(row: Record<string, unknown>): Entitlement {
  return {
    id: String(row.id), guildId: String(row.guild_id), discordUserId: String(row.discord_user_id), productId: String(row.product_id || ''),
    roleId: String(row.role_id || ''), paymentId: String(row.payment_id || ''), grantedBy: String(row.granted_by || ''), grantNote: String(row.grant_note || ''), status: String(row.status) as Entitlement['status'],
    expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function listCreators(guildId: string): Promise<CreatorChannelConfig[]> {
  const rows = await sql`select * from public.creator_channels where guild_id = ${guildId} order by position asc, created_at asc`;
  return rows.map((row) => rowToCreator(row));
}

export const postgresStore = {
  async getSettings(guildId: string, guildName = ''): Promise<GuildSettings> {
    let rows = await sql`select * from public.guild_settings where guild_id = ${guildId} limit 1`;
    if (!rows.length) {
      await sql`insert into public.guild_settings (guild_id, guild_name, updated_at) values (${guildId}, ${guildName}, now()) on conflict (guild_id) do nothing`;
      rows = await sql`select * from public.guild_settings where guild_id = ${guildId} limit 1`;
    } else if (guildName && String(rows[0].guild_name || '') !== guildName) {
      await sql`update public.guild_settings set guild_name = ${guildName}, updated_at = now() where guild_id = ${guildId}`;
      rows[0].guild_name = guildName;
    }
    return rowToSettings(rows[0], await listCreators(guildId));
  },

  async updateSettings(guildId: string, patch: Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>): Promise<GuildSettings> {
    const current = await this.getSettings(guildId);
    const next = { ...current, ...patch };
    await sql.begin(async (tx) => {
      await tx`
        insert into public.guild_settings (
          guild_id, guild_name, premium_role_id, control_channel_id, payment_panel_channel_id,
          default_room_category_id, room_name_template, donation_min_vnd, sepay_bank_account_id, bank_code,
          bank_account_number, bank_account_name, static_qr_url, updated_at
        ) values (
          ${guildId}, ${next.guildName}, ${next.premiumRoleId}, ${next.controlChannelId}, ${next.paymentPanelChannelId},
          ${next.defaultRoomCategoryId}, ${next.roomNameTemplate}, ${next.donationMinVnd}, ${next.sepayBankAccountId}, ${next.bankCode},
          ${next.bankAccountNumber}, ${next.bankAccountName}, ${next.staticQrUrl}, now()
        ) on conflict (guild_id) do update set
          guild_name = excluded.guild_name, premium_role_id = excluded.premium_role_id,
          control_channel_id = excluded.control_channel_id, payment_panel_channel_id = excluded.payment_panel_channel_id,
          default_room_category_id = excluded.default_room_category_id, room_name_template = excluded.room_name_template,
          donation_min_vnd = excluded.donation_min_vnd, sepay_bank_account_id = excluded.sepay_bank_account_id, bank_code = excluded.bank_code,
          bank_account_number = excluded.bank_account_number, bank_account_name = excluded.bank_account_name,
          static_qr_url = excluded.static_qr_url, updated_at = now()
      `;
      if (patch.creatorChannels !== undefined) {
        await tx`delete from public.creator_channels where guild_id = ${guildId}`;
        for (const [position, creator] of next.creatorChannels.entries()) {
          await tx`
            insert into public.creator_channels (
              guild_id, channel_id, label, mode, category_id, allowed_role_id,
              notify_join_leave, auto_transfer_owner, position, created_at, updated_at
            ) values (
              ${guildId}, ${creator.channelId}, ${creator.label}, ${creator.mode}, ${creator.categoryId || null}, ${creator.allowedRoleId || null},
              ${Boolean(creator.notifyJoinLeave)}, ${creator.autoTransferOwner !== false}, ${position}, now(), now()
            )
          `;
        }
      }
    });
    return this.getSettings(guildId);
  },

  async listProducts(guildId: string, activeOnly = false): Promise<Product[]> {
    const rows = activeOnly
      ? await sql`select * from public.products where guild_id = ${guildId} and active = true order by sort_order asc, price_vnd asc`
      : await sql`select * from public.products where guild_id = ${guildId} order by sort_order asc, created_at asc`;
    return rows.map((row) => rowToProduct(row));
  },

  async getProduct(productId: string): Promise<Product | undefined> {
    if (!productId) return undefined;
    const rows = await sql`select * from public.products where id = ${productId}::uuid limit 1`;
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  },

  async createProduct(input: Omit<Product, 'id' | 'createdAt' | 'updatedAt'>): Promise<Product> {
    const productId = id();
    await sql`insert into public.products (id, guild_id, name, description, price_vnd, role_id, duration_days, active, sort_order, created_at, updated_at)
      values (${productId}::uuid, ${input.guildId}, ${input.name}, ${input.description}, ${input.priceVnd}, ${input.roleId}, ${input.durationDays}, ${input.active}, ${input.sortOrder}, now(), now())`;
    return (await this.getProduct(productId))!;
  },

  async updateProduct(productId: string, patch: Partial<Omit<Product, 'id' | 'guildId' | 'createdAt' | 'updatedAt'>>): Promise<Product | undefined> {
    const current = await this.getProduct(productId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await sql`update public.products set name=${next.name}, description=${next.description}, price_vnd=${next.priceVnd}, role_id=${next.roleId}, duration_days=${next.durationDays}, active=${next.active}, sort_order=${next.sortOrder}, updated_at=now() where id=${productId}::uuid`;
    return this.getProduct(productId);
  },

  async deleteProduct(productId: string): Promise<void> {
    await sql`delete from public.products where id = ${productId}::uuid`;
  },

  async insertRoom(input: Omit<Room, 'id' | 'createdAt'>): Promise<Room> {
    const roomId = id();
    await sql`insert into public.rooms (id,guild_id,channel_id,owner_id,owner_tag,original_owner_id,mode,creator_channel_id,control_message_id,notify_join_leave,password_hash,password_salt,created_at)
      values (${roomId}::uuid,${input.guildId},${input.channelId},${input.ownerId},${input.ownerTag},${input.originalOwnerId || input.ownerId},${input.mode},${input.creatorChannelId},${input.controlMessageId},${input.notifyJoinLeave},${input.passwordHash},${input.passwordSalt},now())`;
    return (await this.getRoomByChannel(input.channelId))!;
  },

  async updateRoom(channelId: string, patch: Partial<Pick<Room, 'controlMessageId' | 'ownerId' | 'ownerTag' | 'originalOwnerId' | 'mode' | 'notifyJoinLeave' | 'passwordHash' | 'passwordSalt'>>): Promise<Room | undefined> {
    const current = await this.getRoomByChannel(channelId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await sql`update public.rooms set owner_id=${next.ownerId},owner_tag=${next.ownerTag},original_owner_id=${next.originalOwnerId || next.ownerId},mode=${next.mode},control_message_id=${next.controlMessageId},notify_join_leave=${next.notifyJoinLeave},password_hash=${next.passwordHash},password_salt=${next.passwordSalt} where channel_id=${channelId}`;
    return this.getRoomByChannel(channelId);
  },

  async getRoomByChannel(channelId: string): Promise<Room | undefined> {
    const rows = await sql`select * from public.rooms where channel_id=${channelId} limit 1`;
    return rows[0] ? rowToRoom(rows[0]) : undefined;
  },

  async getRoomByOwner(guildId: string, ownerId: string): Promise<Room | undefined> {
    const rows = await sql`select * from public.rooms where guild_id=${guildId} and owner_id=${ownerId} order by created_at desc limit 1`;
    return rows[0] ? rowToRoom(rows[0]) : undefined;
  },

  async getRoomByOwnerAndCreator(guildId: string, ownerId: string, creatorChannelId: string): Promise<Room | undefined> {
    const rows = await sql`select * from public.rooms where guild_id=${guildId} and owner_id=${ownerId} and creator_channel_id=${creatorChannelId} order by created_at asc limit 1`;
    return rows[0] ? rowToRoom(rows[0]) : undefined;
  },

  async listRoomsByOwner(guildId: string, ownerId: string): Promise<Room[]> {
    const rows = await sql`select * from public.rooms where guild_id=${guildId} and owner_id=${ownerId} order by created_at asc`;
    return rows.map((row) => rowToRoom(row));
  },

  async listRooms(guildId: string): Promise<Room[]> {
    const rows = await sql`select * from public.rooms where guild_id=${guildId} order by created_at desc`;
    return rows.map((row) => rowToRoom(row));
  },

  async listAllRooms(): Promise<Room[]> {
    const rows = await sql`select * from public.rooms order by created_at asc`;
    return rows.map((row) => rowToRoom(row));
  },

  async grantRoomAccess(roomId: string, userId: string): Promise<void> {
    await sql`insert into public.room_access (room_id,discord_user_id,created_at) values (${roomId}::uuid,${userId},now()) on conflict (room_id,discord_user_id) do update set created_at=now()`;
  },

  async hasRoomAccess(roomId: string, userId: string): Promise<boolean> {
    const rows = await sql`select 1 from public.room_access where room_id=${roomId}::uuid and discord_user_id=${userId} limit 1`;
    return Boolean(rows.length);
  },

  async revokeRoomAccess(roomId: string, userId: string): Promise<void> {
    await sql`delete from public.room_access where room_id=${roomId}::uuid and discord_user_id=${userId}`;
  },

  async clearRoomAccess(roomId: string): Promise<void> {
    await sql`delete from public.room_access where room_id=${roomId}::uuid`;
  },

  async deleteRoomByChannel(channelId: string): Promise<void> {
    await sql`delete from public.rooms where channel_id=${channelId}`;
  },

  async createPayment(input: { guildId: string; discordUserId: string; discordUserTag: string; type: PaymentType; productId?: string; orderCode: string; expectedAmountVnd: number; qrUrl: string; checkoutUrl: string; note?: string }): Promise<Payment> {
    const paymentId = id();
    await sql`insert into public.payments (id,guild_id,discord_user_id,discord_user_tag,type,product_id,order_code,expected_amount_vnd,qr_url,checkout_url,note,created_at,updated_at)
      values (${paymentId}::uuid,${input.guildId},${input.discordUserId},${input.discordUserTag},${input.type},${input.productId || null}::uuid,${input.orderCode},${input.expectedAmountVnd},${input.qrUrl},${input.checkoutUrl},${input.note || ''},now(),now())`;
    return (await this.getPayment(paymentId))!;
  },

  async getPayment(paymentId: string): Promise<Payment | undefined> {
    if (!paymentId) return undefined;
    const rows = await sql`select * from public.payments where id=${paymentId}::uuid limit 1`;
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  async getPaymentByCode(orderCode: string): Promise<Payment | undefined> {
    const rows = await sql`select * from public.payments where order_code=${orderCode} limit 1`;
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  async getPaymentByProviderTransaction(providerTransactionId: string): Promise<Payment | undefined> {
    const rows = await sql`select * from public.payments where provider_transaction_id=${providerTransactionId} limit 1`;
    return rows[0] ? rowToPayment(rows[0]) : undefined;
  },

  async updatePaymentCheckout(paymentId: string, checkoutUrl: string): Promise<void> {
    await sql`update public.payments set checkout_url=${checkoutUrl},updated_at=now() where id=${paymentId}::uuid`;
  },

  async listPayments(guildId: string, limit = 100): Promise<Payment[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const rows = await sql`select * from public.payments where guild_id=${guildId} order by created_at desc limit ${safeLimit}`;
    return rows.map((row) => rowToPayment(row));
  },

  async getPaidUserSummary(guildId: string): Promise<Record<string, { paidCount: number; paidTotalVnd: number; lastPaidAt: string }>> {
    const rows = await sql`select discord_user_id,count(*)::int as paid_count,coalesce(sum(paid_amount_vnd),0)::bigint as paid_total,max(paid_at) as last_paid_at from public.payments where guild_id=${guildId} and status='paid' group by discord_user_id`;
    return Object.fromEntries(rows.map((row) => [String(row.discord_user_id), { paidCount: Number(row.paid_count || 0), paidTotalVnd: Number(row.paid_total || 0), lastPaidAt: iso(row.last_paid_at) }]));
  },

  async listUserPayments(guildId: string, userId: string, limit = 50): Promise<Payment[]> {
    const rows = await sql`select * from public.payments where guild_id=${guildId} and discord_user_id=${userId} order by created_at desc limit ${Math.min(Math.max(limit, 1), 500)}`;
    return rows.map((row) => rowToPayment(row));
  },

  async recordPaymentEvent(providerTransactionId: string, payload: unknown, paymentId = ''): Promise<boolean> {
    const rows = await sql`insert into public.payment_events (provider_transaction_id,payload_json,payment_id,received_at) values (${providerTransactionId},${sql.json(payload as never)},${paymentId || null}::uuid,now()) on conflict (provider_transaction_id) do nothing returning provider_transaction_id`;
    return Boolean(rows.length);
  },

  async saveUnmatchedTransaction(providerTransactionId: string, payload: unknown): Promise<void> {
    await sql`insert into public.unmatched_transactions (provider_transaction_id,payload_json,received_at) values (${providerTransactionId},${sql.json(payload as never)},now()) on conflict (provider_transaction_id) do update set payload_json=excluded.payload_json,received_at=now()`;
  },

  async markPaymentPaid(paymentId: string, input: { amount: number; providerTransactionId: string; providerReference: string; transferContent: string }): Promise<Payment | undefined> {
    await sql`update public.payments set status='paid',paid_amount_vnd=${input.amount},provider_transaction_id=${input.providerTransactionId},provider_reference=${input.providerReference},transfer_content=${input.transferContent},paid_at=now(),updated_at=now() where id=${paymentId}::uuid and status='pending'`;
    return this.getPayment(paymentId);
  },

  async getEntitlement(guildId: string, userId: string, productId = ''): Promise<Entitlement | undefined> {
    const rows = productId
      ? await sql`select * from public.entitlements where guild_id=${guildId} and discord_user_id=${userId} and product_id=${productId}::uuid and status='active' and (expires_at is null or expires_at>now()) order by created_at desc limit 1`
      : await sql`select * from public.entitlements where guild_id=${guildId} and discord_user_id=${userId} and status='active' and (expires_at is null or expires_at>now()) order by expires_at desc nulls first,created_at desc limit 1`;
    return rows[0] ? rowToEntitlement(rows[0]) : undefined;
  },

  async listEntitlements(guildId: string, userId?: string): Promise<Entitlement[]> {
    const rows = userId
      ? await sql`select * from public.entitlements where guild_id=${guildId} and discord_user_id=${userId} order by created_at desc`
      : await sql`select * from public.entitlements where guild_id=${guildId} order by created_at desc`;
    return rows.map((row) => rowToEntitlement(row));
  },

  async upsertEntitlement(input: { guildId: string; discordUserId: string; productId: string; roleId: string; paymentId: string; expiresAt: string }): Promise<Entitlement> {
    const existing = await this.getEntitlement(input.guildId, input.discordUserId, input.productId);
    if (existing) {
      await sql`update public.entitlements set role_id=${input.roleId},payment_id=${input.paymentId}::uuid,status='active',expires_at=${input.expiresAt || null}::timestamptz,updated_at=now() where id=${existing.id}::uuid`;
      await sql`delete from public.entitlement_notifications where entitlement_id=${existing.id}::uuid`;
      return (await this.listEntitlements(input.guildId, input.discordUserId)).find((item) => item.id === existing.id)!;
    }
    const entitlementId = id();
    await sql`insert into public.entitlements (id,guild_id,discord_user_id,product_id,role_id,payment_id,status,expires_at,created_at,updated_at)
      values (${entitlementId}::uuid,${input.guildId},${input.discordUserId},${input.productId || null}::uuid,${input.roleId},${input.paymentId}::uuid,'active',${input.expiresAt || null}::timestamptz,now(),now())`;
    return (await this.listEntitlements(input.guildId, input.discordUserId)).find((item) => item.id === entitlementId)!;
  },

  async grantManualEntitlement(input: { guildId: string; discordUserId: string; roleId: string; days: number; extend: boolean; grantedBy: string; note?: string }): Promise<Entitlement> {
    const rows = await sql`select * from public.entitlements where guild_id=${input.guildId} and discord_user_id=${input.discordUserId} and product_id is null and payment_id is null order by created_at desc limit 1`;
    const existing = rows[0];
    const currentExpiry = iso(existing?.expires_at);
    let expiresAt = '';
    if (input.days > 0) {
      const base = input.extend && currentExpiry && new Date(currentExpiry).getTime() > Date.now() ? new Date(currentExpiry) : new Date();
      base.setDate(base.getDate() + input.days);
      expiresAt = base.toISOString();
    }
    if (existing) {
      const updated = await sql`update public.entitlements set role_id=${input.roleId},status='active',expires_at=${expiresAt || null}::timestamptz,granted_by=${input.grantedBy},grant_note=${input.note || ''},updated_at=now() where id=${String(existing.id)}::uuid returning *`;
      return rowToEntitlement(updated[0]);
    }
    const entitlementId = id();
    const inserted = await sql`insert into public.entitlements (id,guild_id,discord_user_id,product_id,role_id,payment_id,status,expires_at,granted_by,grant_note,created_at,updated_at) values (${entitlementId}::uuid,${input.guildId},${input.discordUserId},null,${input.roleId},null,'active',${expiresAt || null}::timestamptz,${input.grantedBy},${input.note || ''},now(),now()) returning *`;
    return rowToEntitlement(inserted[0]);
  },

  async revokeUserEntitlements(guildId: string, userId: string, grantedBy: string): Promise<void> {
    await sql`update public.entitlements set status='revoked',granted_by=${grantedBy},updated_at=now() where guild_id=${guildId} and discord_user_id=${userId} and status='active'`;
  },

  async hasActiveEntitlement(guildId: string, userId: string): Promise<boolean> {
    return Boolean(await this.getEntitlement(guildId, userId));
  },

  async hasActiveEntitlementForRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
    const rows = await sql`select 1 from public.entitlements where guild_id=${guildId} and discord_user_id=${userId} and role_id=${roleId} and status='active' and (expires_at is null or expires_at>now()) limit 1`;
    return Boolean(rows.length);
  },

  async listEntitlementsNeedingReminder(withinDays = 3): Promise<Entitlement[]> {
    const rows = await sql`select e.* from public.entitlements e left join public.entitlement_notifications n on n.entitlement_id=e.id and n.kind='renewal_3d' where e.status='active' and e.expires_at is not null and e.expires_at>now() and e.expires_at<=now()+(${Math.max(1, withinDays)}::text || ' days')::interval and n.entitlement_id is null order by e.expires_at asc`;
    return rows.map((row) => rowToEntitlement(row));
  },

  async markEntitlementReminder(entitlementId: string, kind = 'renewal_3d'): Promise<void> {
    await sql`insert into public.entitlement_notifications (entitlement_id,kind,sent_at) values (${entitlementId}::uuid,${kind},now()) on conflict do nothing`;
  },

  async expireDueEntitlements(): Promise<Entitlement[]> {
    const rows = await sql`update public.entitlements set status='expired',updated_at=now() where status='active' and expires_at is not null and expires_at<=now() returning *`;
    return rows.map((row) => rowToEntitlement(row));
  },

  async getStats(guildId: string): Promise<{ paidTotalVnd: number; paidCount: number; pendingCount: number; donorCount: number; activeRooms: number }> {
    const [paymentRows, roomRows] = await Promise.all([
      sql`select coalesce(sum(case when status='paid' then paid_amount_vnd else 0 end),0)::bigint as paid_total,count(*) filter (where status='paid')::int as paid_count,count(*) filter (where status='pending')::int as pending_count,count(distinct discord_user_id) filter (where status='paid')::int as donor_count from public.payments where guild_id=${guildId}`,
      sql`select count(*)::int as count from public.rooms where guild_id=${guildId}`,
    ]);
    const row = paymentRows[0] || {};
    return { paidTotalVnd: Number(row.paid_total || 0), paidCount: Number(row.paid_count || 0), pendingCount: Number(row.pending_count || 0), donorCount: Number(row.donor_count || 0), activeRooms: Number(roomRows[0]?.count || 0) };
  },

  async getGlobalStats(): Promise<{ paidTotalVnd: number; paidCount: number; pendingCount: number; donorCount: number; donationTotalVnd: number; donationCount: number; productTotalVnd: number; activeRooms: number; guildCount: number }> {
    const [paymentRows, roomRows, guildRows] = await Promise.all([
      sql`select coalesce(sum(case when status='paid' then paid_amount_vnd else 0 end),0)::bigint as paid_total,count(*) filter (where status='paid')::int as paid_count,count(*) filter (where status='pending')::int as pending_count,count(distinct guild_id || ':' || discord_user_id) filter (where status='paid')::int as donor_count,coalesce(sum(case when status='paid' and type='donation' then paid_amount_vnd else 0 end),0)::bigint as donation_total,count(*) filter (where status='paid' and type='donation')::int as donation_count,coalesce(sum(case when status='paid' and type='product' then paid_amount_vnd else 0 end),0)::bigint as product_total from public.payments`,
      sql`select count(*)::int as count from public.rooms`,
      sql`select count(*)::int as count from public.guild_settings`,
    ]);
    const row = paymentRows[0] || {};
    return { paidTotalVnd: Number(row.paid_total || 0), paidCount: Number(row.paid_count || 0), pendingCount: Number(row.pending_count || 0), donorCount: Number(row.donor_count || 0), donationTotalVnd: Number(row.donation_total || 0), donationCount: Number(row.donation_count || 0), productTotalVnd: Number(row.product_total || 0), activeRooms: Number(roomRows[0]?.count || 0), guildCount: Number(guildRows[0]?.count || 0) };
  },

  async listAllPayments(limit = 100): Promise<Payment[]> {
    const rows = await sql`select * from public.payments order by created_at desc limit ${Math.min(Math.max(limit,1),500)}`;
    return rows.map((row) => rowToPayment(row));
  },

  async createSession(input: { user: SessionUser; accessToken: string; refreshToken: string; expiresAt: number; guilds: OAuthGuild[] }): Promise<AuthSession> {
    const sessionId = crypto.randomBytes(32).toString('hex');
    await sql`insert into public.sessions (id,user_json,access_token,refresh_token,expires_at,guilds_json,created_at) values (${sessionId},${sql.json(input.user as never)},${input.accessToken},${input.refreshToken},${input.expiresAt},${sql.json(input.guilds as never)},now())`;
    return { id: sessionId, ...input };
  },

  async getSession(sessionId: string): Promise<AuthSession | undefined> {
    const rows = await sql`select * from public.sessions where id=${sessionId} and expires_at>${Date.now()} limit 1`;
    const row = rows[0];
    if (!row) return undefined;
    return { id: String(row.id), user: row.user_json as unknown as SessionUser, accessToken: String(row.access_token), refreshToken: String(row.refresh_token || ''), expiresAt: Number(row.expires_at), guilds: row.guilds_json as unknown as OAuthGuild[] };
  },

  async updateSession(sessionId: string, input: Partial<Pick<AuthSession, 'accessToken' | 'refreshToken' | 'expiresAt' | 'guilds'>>): Promise<AuthSession | undefined> {
    const current = await this.getSession(sessionId);
    if (!current) return undefined;
    const next = { ...current, ...input };
    await sql`update public.sessions set access_token=${next.accessToken},refresh_token=${next.refreshToken},expires_at=${next.expiresAt},guilds_json=${sql.json(next.guilds as never)} where id=${sessionId}`;
    return this.getSession(sessionId);
  },

  async deleteSession(sessionId: string): Promise<void> {
    await sql`delete from public.sessions where id=${sessionId}`;
  },

  async close(): Promise<void> {
    await sql.end({ timeout: 5 });
  },
};

export { sql as postgresSql };
