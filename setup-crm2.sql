-- CRM化: 顧客の統合(名寄せ)機能用のスキーマ変更
-- Supabase SQL Editor で実行してください。

-- 統合された顧客は削除せず「どの顧客に統合されたか」を記録する。
-- (削除するとMF取引先同期で重複が再作成されてしまうため、行を残して非表示にする方式)
alter table customers add column if not exists merged_into bigint;
