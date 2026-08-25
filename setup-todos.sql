-- TODOタブ用の共有TODOテーブル
-- Supabase SQL Editor で実行してください。
--
-- 週間ボードの「今週のTODO」は週(weeks)に紐づく個人メモだったが、
-- 期限・案件との紐付けを持たせて週をまたいで管理するため、独立したテーブルにする。
-- 他テーブルと同様、anon keyで読み書きする運用(社内限定ツールのため)。

create table if not exists todos (
  id          bigserial primary key,
  text        text not null,
  assignee    text,                      -- 担当(master.membersの氏名)
  due_date    date,                      -- 期限
  case_id     bigint,                    -- 紐付ける案件(cases.id)。未紐付けはnull
  done        boolean not null default false,
  done_at     timestamptz,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists todos_assignee_idx on todos (assignee);
create index if not exists todos_case_id_idx  on todos (case_id);
create index if not exists todos_done_idx     on todos (done);
