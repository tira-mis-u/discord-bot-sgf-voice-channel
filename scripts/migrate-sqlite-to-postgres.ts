import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { sqlite, sqliteStore } from '../src/storage/sqlite-store.js';
import { postgresSql as sql, postgresStore } from '../src/storage/postgres-store.js';

if (!config.databaseUrl) throw new Error('DATABASE_URL is required. Use the Supabase PostgreSQL connection string.');

const schemaFile = path.resolve('supabase/migrations/0001_initial_schema.sql');
if (!fs.existsSync(schemaFile)) throw new Error(`Missing schema migration: ${schemaFile}`);

console.log('[migration] applying PostgreSQL schema');
await sql.unsafe(fs.readFileSync(schemaFile, 'utf8'));

const guildRows = sqlite.prepare('select guild_id, guild_name from guild_settings order by guild_id').all() as Array<{ guild_id: string; guild_name: string }>;
for (const guildRow of guildRows) {
  const settings = sqliteStore.getSettings(guildRow.guild_id, guildRow.guild_name);
  await postgresStore.updateSettings(settings.guildId, settings);
}
console.log(`[migration] guild settings and creators: ${guildRows.length}`);

const productRows = sqlite.prepare('select * from products order by created_at').all() as Record<string, unknown>[];
for (const row of productRows) {
  await sql`insert into public.products (id,guild_id,name,description,price_vnd,role_id,duration_days,active,sort_order,created_at,updated_at)
    values (${String(row.id)}::uuid,${String(row.guild_id)},${String(row.name)},${String(row.description || '')},${Number(row.price_vnd)},${String(row.role_id || '')},${Math.max(1,Number(row.duration_days || 30))},${Boolean(row.active)},${Number(row.sort_order || 0)},${String(row.created_at)}::timestamptz,${String(row.updated_at)}::timestamptz)
    on conflict (id) do update set name=excluded.name,description=excluded.description,price_vnd=excluded.price_vnd,role_id=excluded.role_id,duration_days=excluded.duration_days,active=excluded.active,sort_order=excluded.sort_order,updated_at=excluded.updated_at`;
}
console.log(`[migration] products: ${productRows.length}`);

const roomRows = sqlite.prepare('select * from rooms order by created_at').all() as Record<string, unknown>[];
for (const row of roomRows) {
  const mode = String(row.mode) === 'premium' || String(row.mode) === 'editable' ? 'editable' : 'basic';
  await sql`insert into public.rooms (id,guild_id,channel_id,owner_id,owner_tag,mode,creator_channel_id,control_message_id,notify_join_leave,password_hash,password_salt,created_at)
    values (${String(row.id)}::uuid,${String(row.guild_id)},${String(row.channel_id)},${String(row.owner_id)},${String(row.owner_tag)},${mode},${String(row.creator_channel_id)},${String(row.control_message_id || '')},${Boolean(row.notify_join_leave)},${String(row.password_hash || '')},${String(row.password_salt || '')},${String(row.created_at)}::timestamptz)
    on conflict (id) do update set owner_id=excluded.owner_id,owner_tag=excluded.owner_tag,mode=excluded.mode,control_message_id=excluded.control_message_id,notify_join_leave=excluded.notify_join_leave,password_hash=excluded.password_hash,password_salt=excluded.password_salt`;
}
console.log(`[migration] rooms: ${roomRows.length}`);

const paymentRows = sqlite.prepare('select * from payments order by created_at').all() as Record<string, unknown>[];
for (const row of paymentRows) {
  await sql`insert into public.payments (id,guild_id,discord_user_id,discord_user_tag,type,product_id,order_code,expected_amount_vnd,paid_amount_vnd,status,provider_transaction_id,provider_reference,transfer_content,qr_url,checkout_url,note,paid_at,created_at,updated_at)
    values (${String(row.id)}::uuid,${String(row.guild_id)},${String(row.discord_user_id)},${String(row.discord_user_tag)},${String(row.type)},${row.product_id ? String(row.product_id) : null}::uuid,${String(row.order_code)},${Number(row.expected_amount_vnd)},${Number(row.paid_amount_vnd || 0)},${String(row.status)},${String(row.provider_transaction_id || '')},${String(row.provider_reference || '')},${String(row.transfer_content || '')},${String(row.qr_url || '')},${String(row.checkout_url || '')},${String(row.note || '')},${row.paid_at ? String(row.paid_at) : null}::timestamptz,${String(row.created_at)}::timestamptz,${String(row.updated_at)}::timestamptz)
    on conflict (id) do update set paid_amount_vnd=excluded.paid_amount_vnd,status=excluded.status,provider_transaction_id=excluded.provider_transaction_id,provider_reference=excluded.provider_reference,transfer_content=excluded.transfer_content,qr_url=excluded.qr_url,checkout_url=excluded.checkout_url,note=excluded.note,paid_at=excluded.paid_at,updated_at=excluded.updated_at`;
}
console.log(`[migration] payments: ${paymentRows.length}`);

const eventRows = sqlite.prepare('select * from payment_events').all() as Record<string, unknown>[];
for (const row of eventRows) {
  await sql`insert into public.payment_events (provider_transaction_id,payload_json,payment_id,received_at)
    values (${String(row.provider_transaction_id)},${sql.json(JSON.parse(String(row.payload_json || '{}')) as never)},${row.payment_id ? String(row.payment_id) : null}::uuid,${String(row.received_at)}::timestamptz)
    on conflict (provider_transaction_id) do nothing`;
}
console.log(`[migration] payment events: ${eventRows.length}`);

const entitlementRows = sqlite.prepare('select * from entitlements order by created_at').all() as Record<string, unknown>[];
for (const row of entitlementRows) {
  await sql`insert into public.entitlements (id,guild_id,discord_user_id,product_id,role_id,payment_id,status,expires_at,created_at,updated_at)
    values (${String(row.id)}::uuid,${String(row.guild_id)},${String(row.discord_user_id)},${row.product_id ? String(row.product_id) : null}::uuid,${String(row.role_id || '')},${String(row.payment_id)}::uuid,${String(row.status)},${row.expires_at ? String(row.expires_at) : null}::timestamptz,${String(row.created_at)}::timestamptz,${String(row.updated_at)}::timestamptz)
    on conflict (id) do update set role_id=excluded.role_id,payment_id=excluded.payment_id,status=excluded.status,expires_at=excluded.expires_at,updated_at=excluded.updated_at`;
}
console.log(`[migration] entitlements: ${entitlementRows.length}`);

const accessRows = sqlite.prepare('select * from room_access').all() as Record<string, unknown>[];
for (const row of accessRows) {
  await sql`insert into public.room_access (room_id,discord_user_id,created_at) values (${String(row.room_id)}::uuid,${String(row.discord_user_id)},${String(row.created_at)}::timestamptz) on conflict do nothing`;
}

const notificationRows = sqlite.prepare('select * from entitlement_notifications').all() as Record<string, unknown>[];
for (const row of notificationRows) {
  await sql`insert into public.entitlement_notifications (entitlement_id,kind,sent_at) values (${String(row.entitlement_id)}::uuid,${String(row.kind)},${String(row.sent_at)}::timestamptz) on conflict do nothing`;
}

const unmatchedRows = sqlite.prepare('select * from unmatched_transactions').all() as Record<string, unknown>[];
for (const row of unmatchedRows) {
  await sql`insert into public.unmatched_transactions (provider_transaction_id,payload_json,received_at)
    values (${String(row.provider_transaction_id)},${sql.json(JSON.parse(String(row.payload_json || '{}')) as never)},${String(row.received_at)}::timestamptz)
    on conflict (provider_transaction_id) do update set payload_json=excluded.payload_json,received_at=excluded.received_at`;
}

console.log(`[migration] room access: ${accessRows.length}`);
console.log(`[migration] entitlement notifications: ${notificationRows.length}`);
console.log(`[migration] unmatched transactions: ${unmatchedRows.length}`);
console.log('[migration] OAuth sessions were intentionally not copied. New sessions are stored in Redis when configured.');

await postgresStore.close();
sqlite.close();
console.log('[migration] completed');
