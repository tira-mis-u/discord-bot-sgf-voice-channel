-- begin;

create table if not exists public.guild_settings (
  guild_id text primary key,
  guild_name text not null default '',
  premium_role_id text not null default '',
  control_channel_id text not null default '',
  payment_panel_channel_id text not null default '',
  default_room_category_id text not null default '',
  room_name_template text not null default '{user}''s room',
  donation_min_vnd bigint not null default 1000 check (donation_min_vnd >= 1000),
  sepay_bank_account_id text not null default '',
  bank_code text not null default '',
  bank_account_number text not null default '',
  bank_account_name text not null default '',
  static_qr_url text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.creator_channels (
  guild_id text not null references public.guild_settings(guild_id) on delete cascade,
  channel_id text not null,
  label text not null default 'Tạo phòng',
  mode text not null default 'editable' check (mode in ('basic', 'editable')),
  category_id text,
  allowed_role_id text,
  notify_join_leave boolean not null default false,
  auto_transfer_owner boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, channel_id)
);
create index if not exists idx_creator_channels_guild_position on public.creator_channels(guild_id, position);

create table if not exists public.products (
  id uuid primary key,
  guild_id text not null references public.guild_settings(guild_id) on delete cascade,
  name text not null,
  description text not null default '',
  price_vnd bigint not null check (price_vnd >= 1000),
  role_id text not null default '',
  duration_days integer not null default 30 check (duration_days >= 1),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_products_guild on public.products(guild_id, active, sort_order);

create table if not exists public.rooms (
  id uuid primary key,
  guild_id text not null references public.guild_settings(guild_id) on delete cascade,
  channel_id text not null unique,
  owner_id text not null,
  owner_tag text not null,
  mode text not null check (mode in ('basic', 'editable')),
  creator_channel_id text not null,
  control_message_id text not null default '',
  notify_join_leave boolean not null default false,
  password_hash text not null default '',
  password_salt text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_rooms_guild on public.rooms(guild_id);
create index if not exists idx_rooms_owner on public.rooms(guild_id, owner_id, created_at);

create table if not exists public.payments (
  id uuid primary key,
  guild_id text not null references public.guild_settings(guild_id) on delete cascade,
  discord_user_id text not null,
  discord_user_tag text not null,
  type text not null check (type in ('product', 'donation')),
  product_id uuid references public.products(id) on delete set null,
  order_code text not null unique,
  expected_amount_vnd bigint not null check (expected_amount_vnd >= 0),
  paid_amount_vnd bigint not null default 0 check (paid_amount_vnd >= 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  provider_transaction_id text not null default '',
  provider_reference text not null default '',
  transfer_content text not null default '',
  qr_url text not null default '',
  checkout_url text not null default '',
  note text not null default '',
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_payments_provider_transaction on public.payments(provider_transaction_id) where provider_transaction_id <> '';
create index if not exists idx_payments_guild_created on public.payments(guild_id, created_at desc);
create index if not exists idx_payments_user_status on public.payments(guild_id, discord_user_id, status);

create table if not exists public.payment_events (
  provider_transaction_id text primary key,
  payload_json jsonb not null,
  payment_id uuid references public.payments(id) on delete set null,
  received_at timestamptz not null default now()
);

create table if not exists public.entitlements (
  id uuid primary key,
  guild_id text not null references public.guild_settings(guild_id) on delete cascade,
  discord_user_id text not null,
  product_id uuid references public.products(id) on delete set null,
  role_id text not null default '',
  payment_id uuid references public.payments(id) on delete restrict,
  granted_by text not null default '',
  grant_note text not null default '',
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_entitlements_user on public.entitlements(guild_id, discord_user_id, status);
create index if not exists idx_entitlements_expiry on public.entitlements(status, expires_at);

create table if not exists public.sessions (
  id text primary key,
  user_json jsonb not null,
  access_token text not null,
  refresh_token text not null default '',
  expires_at bigint not null,
  guilds_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_expires_at on public.sessions(expires_at);

create table if not exists public.unmatched_transactions (
  provider_transaction_id text primary key,
  payload_json jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists public.room_access (
  room_id uuid not null references public.rooms(id) on delete cascade,
  discord_user_id text not null,
  created_at timestamptz not null default now(),
  primary key (room_id, discord_user_id)
);

create table if not exists public.entitlement_notifications (
  entitlement_id uuid not null references public.entitlements(id) on delete cascade,
  kind text not null,
  sent_at timestamptz not null default now(),
  primary key (entitlement_id, kind)
);

alter table public.guild_settings enable row level security;
alter table public.creator_channels enable row level security;
alter table public.products enable row level security;
alter table public.rooms enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.entitlements enable row level security;
alter table public.sessions enable row level security;
alter table public.unmatched_transactions enable row level security;
alter table public.room_access enable row level security;
alter table public.entitlement_notifications enable row level security;

revoke all on all tables in schema public from anon, authenticated;

commit;
