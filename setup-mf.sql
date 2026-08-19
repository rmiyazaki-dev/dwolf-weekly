-- Money Forward クラウド請求書 連携用テーブル
-- Supabase SQL Editor で実行してください(setup.sql / setup-v3.sql と同じ要領)。

-- MFのOAuthトークン保管専用。RLSを有効化しポリシーを一切作らないことで、
-- anon/authenticatedロールからは完全にアクセス不可にする(service_role keyのみ操作可能)。
create table if not exists mf_tokens (
  id smallint primary key default 1,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  office_id text,
  office_name text,
  connected_at timestamptz,
  updated_at timestamptz default now(),
  constraint mf_tokens_singleton check (id = 1)
);
alter table mf_tokens enable row level security;
-- ポリシーは意図的に作成しない(service_role keyはRLSを自動バイパスする)。

-- MFの見積書/請求書のうち、既存案件と自動突合できなかったものの一覧。
-- 他テーブル同様、anon keyでの読み書きを許可する(案件管理タブから人が紐付け操作を行うため)。
create table if not exists mf_review_queue (
  id bigserial primary key,
  type text not null check (type in ('quote', 'billing')),
  mf_id text not null,
  mf_number text,
  partner_name text,
  amount numeric,
  issue_date date,
  related_quote_mf_id text,
  raw jsonb,
  status text not null default 'pending' check (status in ('pending', 'linked', 'skipped')),
  linked_case_id bigint,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (type, mf_id)
);
