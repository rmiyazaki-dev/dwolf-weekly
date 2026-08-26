-- ============================================================
-- メンバー名の一括変更(表記ゆれの統一・改名に使う)
--
-- このアプリは氏名を「文字列」として各所に保存している。
--   例) cases.data.salesOwner / weeks.data.schedule のキー / todos.assignee
--       nippo.author / audit_log.author / settings の各種キー など
-- そのためマスター管理で名前を変えても過去データは古い名前のまま残る。
-- このスクリプトで全テーブルをまとめて置き換える。
--
-- 【使い方】
--  1) 下の old_name / new_name を書き換える
--  2) まず「① 事前確認」だけを実行して、対象件数を確認する
--  3) 問題なければ「② 置換の実行」を実行する
--  4)「③ 事後確認」で残りがゼロになったことを確認する
--
-- ※ 実行前にバックアップを取ることを推奨します。
-- ※ 何も見つからなければ何も起きません(空振りしても安全です)。
-- ============================================================

-- ------------------------------------------------------------
-- ① 事前確認:どのテーブルに何件あるか
-- ------------------------------------------------------------
with target as (select '岩上星音'::text as old_name)
select 'kv' as tbl, count(*) from kv, target where value::text like '%'||old_name||'%'
union all select 'weeks',        count(*) from weeks, target        where data::text  like '%'||old_name||'%'
union all select 'cases',        count(*) from cases, target        where data::text  like '%'||old_name||'%'
union all select 'todos',        count(*) from todos, target        where assignee = old_name or created_by = old_name
union all select 'nippo',        count(*) from nippo, target        where author = old_name
union all select 'announcements',count(*) from announcements, target where author = old_name or reads::text like '%'||old_name||'%'
union all select 'audit_log',    count(*) from audit_log, target    where author = old_name
union all select 'case_history', count(*) from case_history, target where author = old_name
union all select 'comments',     count(*) from comments, target     where author = old_name
union all select 'case_files',   count(*) from case_files, target   where author = old_name;

-- ------------------------------------------------------------
-- ② 置換の実行
-- ------------------------------------------------------------
do $$
declare
  old_name text := '岩上星音';   -- ← 変更前の名前
  new_name text := '岩神星音';   -- ← 変更後の名前
  n int;
  total int := 0;
begin
  if old_name = new_name then
    raise notice '変更前と変更後が同じです。何もしません。';
    return;
  end if;

  -- JSONB列は、キー側にも値側にも名前が入る(例:schedule の "岩上星音": [...])。
  -- そのため一度テキストに変換してから置換し、JSONBに戻す。
  update kv set value = replace(value::text, old_name, new_name)::jsonb
    where value::text like '%'||old_name||'%';
  get diagnostics n = row_count; total := total + n; raise notice 'kv: % 行', n;

  update weeks set data = replace(data::text, old_name, new_name)::jsonb
    where data::text like '%'||old_name||'%';
  get diagnostics n = row_count; total := total + n; raise notice 'weeks: % 行', n;

  update cases set data = replace(data::text, old_name, new_name)::jsonb
    where data::text like '%'||old_name||'%';
  get diagnostics n = row_count; total := total + n; raise notice 'cases: % 行', n;

  -- ここから下は通常のテキスト列
  update todos set assignee = new_name where assignee = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'todos.assignee: % 行', n;
  update todos set created_by = new_name where created_by = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'todos.created_by: % 行', n;

  update nippo set author = new_name where author = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'nippo: % 行', n;

  update announcements set author = new_name where author = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'announcements.author: % 行', n;
  -- 既読者リスト(JSONB配列)も置き換える
  update announcements set reads = replace(reads::text, old_name, new_name)::jsonb
    where reads::text like '%'||old_name||'%';
  get diagnostics n = row_count; total := total + n; raise notice 'announcements.reads: % 行', n;

  update audit_log set author = new_name where author = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'audit_log: % 行', n;

  update case_history set author = new_name where author = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'case_history: % 行', n;

  update comments set author = new_name where author = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'comments: % 行', n;

  update case_files set author = new_name where author = old_name;
  get diagnostics n = row_count; total := total + n; raise notice 'case_files: % 行', n;

  raise notice '----- 合計 % 行を更新しました(% → %) -----', total, old_name, new_name;
end $$;

-- ------------------------------------------------------------
-- ③ 事後確認:すべて 0 になっていればOK
-- ------------------------------------------------------------
with target as (select '岩上星音'::text as old_name)
select 'kv' as tbl, count(*) from kv, target where value::text like '%'||old_name||'%'
union all select 'weeks',        count(*) from weeks, target        where data::text  like '%'||old_name||'%'
union all select 'cases',        count(*) from cases, target        where data::text  like '%'||old_name||'%'
union all select 'todos',        count(*) from todos, target        where assignee = old_name or created_by = old_name
union all select 'nippo',        count(*) from nippo, target        where author = old_name
union all select 'announcements',count(*) from announcements, target where author = old_name or reads::text like '%'||old_name||'%'
union all select 'audit_log',    count(*) from audit_log, target    where author = old_name
union all select 'case_history', count(*) from case_history, target where author = old_name
union all select 'comments',     count(*) from comments, target     where author = old_name
union all select 'case_files',   count(*) from case_files, target   where author = old_name;

-- ------------------------------------------------------------
-- ④ Supabase Auth の表示名も合わせる(必要な場合)
-- ------------------------------------------------------------
update auth.users set raw_user_meta_data =
  jsonb_set(coalesce(raw_user_meta_data,'{}'::jsonb), '{display_name}', '"岩神星音"')
  where email = 'iwagami@d-wolf.jp';

select email, raw_user_meta_data->>'display_name' as display_name
  from auth.users order by email;
