-- ============================================================
-- Supabase Auth 導入:全テーブルをログイン必須にする
-- Supabase SQL Editor で実行してください。
--
-- 【これで何が変わるか】
-- 実行後は anon key(index.htmlに書かれている公開鍵)だけではデータに
-- 一切アクセスできなくなり、ログインしたユーザーだけが読み書きできる。
-- Supabaseから届いた "rls_disabled_in_public" の警告もこれで解消される。
--
-- 【実行前に必ず】
-- 1. Authentication → Users で全員分のアカウントを作成しておくこと
--    (未作成のまま実行すると誰もログインできず、アプリが使えなくなる)
-- 2. 念のためデータのバックアップを取っておくこと
-- ============================================================

-- 社内メンバー全員が全データを見る運用のため、
-- 「ログイン済み(authenticated)なら全操作OK」という単純なポリシーにする。
-- 重要なのは anon(未ログイン)を締め出すこと。
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
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'authenticated_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      'authenticated_all', t);
    raise notice 'RLSを有効化しました: %', t;
  end loop;
end $$;

-- 添付ファイル(Storage)もログイン必須にする。
-- 公開URLで配信していたバケットを非公開に切り替え、
-- ログイン済みユーザーだけが読み書きできるようにする。
update storage.buckets set public = false where id = 'case-files';

drop policy if exists "case_files_authenticated_all" on storage.objects;
create policy "case_files_authenticated_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'case-files')
  with check (bucket_id = 'case-files');

-- ============================================================
-- 表示名の設定
-- Authentication → Users で各アカウントを作成したあとに実行する。
-- ここで設定した名前が、アプリ内の「氏名」として使われる。
-- ============================================================
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"宮﨑隆司"')
  where email = 'rmiyazaki@d-wolf.jp';
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"岩神星音"')
  where email = 'iwagami@d-wolf.jp';
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"飯田匡輝"')
  where email = 'iida@d-wolf.jp';
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"多々良鮎"')
  where email = 'tatara@d-wolf.jp';
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"妙見修志"')
  where email = 'myoken@d-wolf.jp';

-- 確認用:表示名が入っているかチェックする
select email, raw_user_meta_data->>'display_name' as display_name from auth.users order by email;

-- ============================================================
-- 【後片付け】共通パスワードはもう使わないので削除する
-- (kvに平文で入っており、これまでは誰でも読めてしまっていた)
-- ============================================================
delete from kv where key = 'app_password';
