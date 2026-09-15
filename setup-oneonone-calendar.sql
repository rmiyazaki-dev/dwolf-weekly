-- D-BORD 1on1: コプロス予定表 OAuth 接続情報（サービスロール専用）
-- refresh token はアプリ側で AES-256-GCM 暗号化してから保存します。
create table if not exists public.oneonone_calendar_tokens (
  id smallint primary key default 1 check (id = 1),
  mailbox text not null check (lower(mailbox) = 'rmiyazaki@copros.co.jp'),
  token text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.oneonone_calendar_tokens enable row level security;
revoke all on table public.oneonone_calendar_tokens from anon, authenticated;
grant select, insert, update on table public.oneonone_calendar_tokens to service_role;
