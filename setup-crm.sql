-- CRM化フェーズ1(顧客基盤)用のスキーマ変更
-- Supabase SQL Editor で実行してください(setup.sql / setup-v3.sql / setup-mf.sql と同じ要領)。
-- 既存の customers テーブルへの列追加のみ。既存データはそのまま保持されます。

alter table customers add column if not exists mf_partner_id text;
create unique index if not exists customers_mf_partner_id_key
  on customers (mf_partner_id) where mf_partner_id is not null;

alter table customers add column if not exists name_kana text;
alter table customers add column if not exists email text;
alter table customers add column if not exists address text;
alter table customers add column if not exists updated_at timestamptz default now();
