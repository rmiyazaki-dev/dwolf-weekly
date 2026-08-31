-- ============================================================
-- D-BORD CRM追加機能
--   顧客360°活動履歴 / 顧客統合取消 / 顧客の30日復元箱
--
-- Supabase SQL Editorで全文を実行してください。
-- setup-crm.sql / setup-crm2.sql / setup-auth.sql /
-- setup-viewer-accounts.sql の実行後を想定しています。
-- 再実行しても既存データを削除しない冪等な構成です。
-- ============================================================

do $$
begin
  if to_regclass('public.customers') is null then
    raise exception 'public.customers がありません。先に既存の基本SQLと setup-crm.sql を実行してください。';
  end if;
end $$;

begin;

-- 顧客の論理削除。MF顧客も行を残すことで同期時の重複再作成を防ぐ。
alter table public.customers add column if not exists merged_into bigint;
alter table public.customers add column if not exists deleted_at timestamptz;
alter table public.customers add column if not exists deleted_by text;

comment on column public.customers.deleted_at is '復元箱へ移動した日時。nullは通常表示、値ありは論理削除済み。';
comment on column public.customers.deleted_by is '復元箱へ移動した操作者の表示名。';

create index if not exists customers_active_name_idx
  on public.customers (name) where deleted_at is null and merged_into is null;
create index if not exists customers_deleted_at_idx
  on public.customers (deleted_at desc) where deleted_at is not null;
create index if not exists customers_merged_into_idx
  on public.customers (merged_into) where merged_into is not null;

-- 電話・訪問・メール・打合せ・メモなどの手入力活動。
-- 案件変更・コメント・TODOは既存データから画面上で合成する。
create table if not exists public.customer_activities (
  id              bigserial primary key,
  customer_id     bigint not null,
  case_id         bigint,
  activity_type   text not null,
  occurred_at     timestamptz not null default now(),
  title           text not null,
  detail          text not null default '',
  contact_person  text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint customer_activities_type_not_blank check (length(btrim(activity_type)) > 0),
  constraint customer_activities_title_not_blank check (length(btrim(title)) > 0)
);

create index if not exists customer_activities_customer_time_idx
  on public.customer_activities (customer_id, occurred_at desc, id desc);
create index if not exists customer_activities_case_idx
  on public.customer_activities (case_id) where case_id is not null;
create index if not exists customer_activities_type_time_idx
  on public.customer_activities (activity_type, occurred_at desc);

-- source=統合元（非表示になる側）、target=統合先（残る側）。
-- 取消時はmoved_case_idsのうち現在も統合先にある案件だけを元へ戻す。
create table if not exists public.customer_merge_history (
  id                   bigserial primary key,
  source_customer_id   bigint not null,
  target_customer_id   bigint not null,
  source_name          text not null,
  target_name          text not null,
  source_snapshot      jsonb not null default '{}'::jsonb,
  target_snapshot      jsonb not null default '{}'::jsonb,
  moved_case_ids       jsonb not null default '[]'::jsonb,
  merged_by            text,
  merged_at            timestamptz not null default now(),
  undone_by            text,
  undone_at            timestamptz,
  constraint customer_merge_history_different_customers check (source_customer_id <> target_customer_id),
  constraint customer_merge_history_case_ids_array check (jsonb_typeof(moved_case_ids) = 'array')
);

create unique index if not exists customer_merge_history_active_source_key
  on public.customer_merge_history (source_customer_id) where undone_at is null;
create index if not exists customer_merge_history_source_time_idx
  on public.customer_merge_history (source_customer_id, merged_at desc);
create index if not exists customer_merge_history_target_time_idx
  on public.customer_merge_history (target_customer_id, merged_at desc);
create index if not exists customer_merge_history_undone_time_idx
  on public.customer_merge_history (undone_at desc) where undone_at is not null;

-- viewer判定は本人が変更できないapp_metadataだけを参照する。
create or replace function public.is_viewer()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'viewer', false);
$$;

revoke execute on function public.is_viewer() from public;
grant execute on function public.is_viewer() to authenticated;
grant execute on function public.is_viewer() to service_role;

alter table public.customer_activities enable row level security;
alter table public.customer_merge_history enable row level security;

-- ログイン済み全員は閲覧可。viewer以外だけが登録・更新・削除できる。
do $$
declare
  t text;
  tables text[] := array['customer_activities','customer_merge_history'];
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I on public.%I', 'authenticated_all', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_select', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_insert', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_update', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', 'authenticated_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (not public.is_viewer())', 'authenticated_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (not public.is_viewer()) with check (not public.is_viewer())', 'authenticated_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (not public.is_viewer())', 'authenticated_delete', t);
  end loop;
end $$;

revoke all privileges on table public.customer_activities from anon;
revoke all privileges on table public.customer_merge_history from anon;
grant select, insert, update, delete on table public.customer_activities to authenticated;
grant select, insert, update, delete on table public.customer_merge_history to authenticated;
grant all privileges on table public.customer_activities to service_role;
grant all privileges on table public.customer_merge_history to service_role;

revoke all privileges on sequence public.customer_activities_id_seq from anon;
revoke all privileges on sequence public.customer_merge_history_id_seq from anon;
grant usage, select on sequence public.customer_activities_id_seq to authenticated;
grant usage, select on sequence public.customer_merge_history_id_seq to authenticated;
grant all privileges on sequence public.customer_activities_id_seq to service_role;
grant all privileges on sequence public.customer_merge_history_id_seq to service_role;

commit;

-- 実行後確認: rowsecurity=true、各新規テーブルに4ポリシーなら正常。
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname='public'
  and tablename in ('customer_activities','customer_merge_history','customers')
order by tablename;

select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname='public'
  and tablename in ('customer_activities','customer_merge_history')
order by tablename, policyname;

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='customers'
  and column_name in ('merged_into','deleted_at','deleted_by')
order by column_name;
