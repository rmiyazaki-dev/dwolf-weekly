-- ============================================================
-- 山下和美・成清沙織 の閲覧専用(viewer)ロールを解除する
-- Supabase SQL Editor で実行してください。setup-viewer-accounts.sql の後に実行した想定。
--
-- 【これで何が変わるか】
-- app_metadata.role='viewer' を外し、他の5名と同じ「ログインすれば
-- 保存・削除もできる」通常アカウントにする。
-- ただし master.members(案件の営業担当・フライト担当・TODOの担当の
-- 選択肢)には追加しない。案件の詳細・顧客・連絡事項・TODOなどの
-- 編集はできるが、案件の「担当」として選ばれる側には出てこない。
-- ============================================================

update auth.users set raw_app_meta_data = raw_app_meta_data - 'role'
  where email in ('yamashita@shimizu-gumi.net', 'narikiyo@shimizu-gumi.net');

-- 確認:2名の role が「(通常メンバー)」に戻っているか
select email,
       raw_user_meta_data->>'display_name' as display_name,
       coalesce(raw_app_meta_data->>'role', '(通常メンバー)') as role
  from auth.users
  order by role, email;

-- ============================================================
-- 【重要】既にログイン中のセッションには反映されない
-- app_metadataの変更はJWTに再度サインインするまで反映されない。
-- 山下さん・成清さんには、一度ログアウトしてログインし直してもらってください。
-- (再ログイン後、ヘッダーの「閲覧専用」バッジが消え、保存・削除ができるようになります)
-- ============================================================
