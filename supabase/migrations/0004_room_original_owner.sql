-- Ghi nhớ host gốc của phòng tạm.
-- Khi host gốc quay lại voice, bot trả lại quyền host cho họ.
alter table public.rooms
  add column if not exists original_owner_id text not null default '';

update public.rooms
  set original_owner_id = owner_id
  where original_owner_id = '';

create index if not exists idx_rooms_channel on public.rooms(channel_id);
