begin;

alter table public.entitlements alter column payment_id drop not null;
alter table public.entitlements add column if not exists granted_by text not null default '';
alter table public.entitlements add column if not exists grant_note text not null default '';

create index if not exists idx_entitlements_manual_grants
  on public.entitlements(guild_id, discord_user_id, status)
  where product_id is null and payment_id is null;

commit;
