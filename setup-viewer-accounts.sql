-- ============================================================
-- 閲覧専用アカウントの追加(山下和美・成清沙織)
-- Supabase SQL Editor で実行してください。setup-auth.sql の実行後に使う想定。
--
-- 【これで何が変わるか】
-- これまでは「ログインさえできれば全員が読み書きできる」ポリシー(authenticated_all)
-- だったが、これを「読み取りは全員可・書き込みはviewerロール以外」に分割する。
-- viewerロールを付けたアカウントは、閲覧はできるが保存・削除などの書き込みが
-- データベース側(RLS)で拒否されるようになる。既存メンバー(5名)の動作は変わらない。
--
-- 【実行前に必ず】
-- Authentication → Users → Add user で、下記2名分のアカウントを先に作成しておくこと
--   山下和美   yamashita@shimizu-gumi.net
--   成清沙織   narikiyo@shimizu-gumi.net
-- (パスワードはこのSQLでは設定できません。ダッシュボードで直接設定してください)
-- ============================================================

-- ------------------------------------------------------------
-- ① 閲覧専用かどうかを判定するヘルパー関数
--    app_metadata はユーザー本人からは書き換えられない領域(service_role/管理者のみ)
--    なので、権限判定に使って安全。
-- ------------------------------------------------------------
create or replace function public.is_viewer()
returns boolean
language sql stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'viewer', false);
$$;

-- ------------------------------------------------------------
-- ② 全テーブルのポリシーを「読み取り全員・書き込みは非viewerのみ」に分割
--    (setup-auth.sqlで作った1本のFOR ALLポリシーを、4本に分け直す)
-- ------------------------------------------------------------
do $$
declare
  t text;
  tables text[] := array[
    'kv','weeks','cases','customers','case_history','case_files',
    'comments','announcements','audit_log','nippo','todos','mf_review_queue'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.'||t) is null then
      raise notice 'テーブル % が見つかりません。スキップします。', t;
      continue;
    end if;

    -- 旧・単一ポリシーを削除(存在すれば)
    execute format('drop policy if exists %I on public.%I', 'authenticated_all', t);
    -- 再実行に備えて、これから作る4本も一度削除してから作り直す
    execute format('drop policy if exists %I on public.%I', 'authenticated_select', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_insert', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_update', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_delete', t);

    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      'authenticated_select', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (not public.is_viewer())',
      'authenticated_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (not public.is_viewer()) with check (not public.is_viewer())',
      'authenticated_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (not public.is_viewer())',
      'authenticated_delete', t);

    raise notice 'ポリシーを分割しました: %', t;
  end loop;
end $$;

-- ------------------------------------------------------------
-- ③ 添付ファイル(Storage)も同様に分割
-- ------------------------------------------------------------
drop policy if exists "case_files_authenticated_all" on storage.objects;
drop policy if exists "case_files_select" on storage.objects;
drop policy if exists "case_files_insert" on storage.objects;
drop policy if exists "case_files_update" on storage.objects;
drop policy if exists "case_files_delete" on storage.objects;

create policy "case_files_select" on storage.objects
  for select to authenticated using (bucket_id = 'case-files');
create policy "case_files_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'case-files' and not public.is_viewer());
create policy "case_files_update" on storage.objects
  for update to authenticated using (bucket_id = 'case-files' and not public.is_viewer())
  with check (bucket_id = 'case-files' and not public.is_viewer());
create policy "case_files_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'case-files' and not public.is_viewer());

-- ------------------------------------------------------------
-- ④ 表示名の設定(通常のメンバーと同じ)
-- ------------------------------------------------------------
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"山下和美"')
  where email = 'yamashita@shimizu-gumi.net';
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"成清沙織"')
  where email = 'narikiyo@shimizu-gumi.net';

-- ------------------------------------------------------------
-- ⑤ この2名を「閲覧専用(viewer)」ロールにする
--    app_metadataはservice_role権限が必要な操作のため、SQL Editor(管理者権限)から実行する。
-- ------------------------------------------------------------
update auth.users set raw_app_meta_data =
  jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb), '{role}', '"viewer"')
  where email = 'yamashita@shimizu-gumi.net';
update auth.users set raw_app_meta_data =
  jsonb_set(coalesce(raw_app_meta_data,'{}'::jsonb), '{role}', '"viewer"')
  where email = 'narikiyo@shimizu-gumi.net';

-- ------------------------------------------------------------
-- ⑥ 確認:2名がviewerになっているか、既存5名にroleが付いていない(=通常メンバー)ことを確認
-- ------------------------------------------------------------
select email,
       raw_user_meta_data->>'display_name' as display_name,
       coalesce(raw_app_meta_data->>'role', '(通常メンバー)') as role
  from auth.users
  order by role, email;

-- ============================================================
-- 【重要】既存ログイン中のセッションには反映されない
-- app_metadataの変更はJWTに再度サインインするまで反映されない。
-- 山下さん・成清さんは、初回ログインまたはログインし直すことで
-- 「閲覧専用」バッジが表示され、保存系の操作ができない状態になる。
-- ============================================================
