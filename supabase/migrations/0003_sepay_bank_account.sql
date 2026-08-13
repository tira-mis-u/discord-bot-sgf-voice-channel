begin;

alter table public.guild_settings
  add column if not exists sepay_bank_account_id text not null default '';

commit;
