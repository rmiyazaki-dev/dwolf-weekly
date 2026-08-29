# CLAUDE.md

このリポジトリの作業ルールは **[AGENTS.md](AGENTS.md)** に集約している(Codexなど他の
エージェントと共通)。作業を始める前に必ず読むこと。

機能・仕様・過去の経緯の詳細は **[HANDOFF.md](HANDOFF.md)**。

特に重要な点(詳細はAGENTS.md):

- `index.html` はビルドされない。編集後は必ず `<script>` を抽出して `node --check` する
- `main` への push が即本番デプロイ。ステージング環境は無い
- `setup-*.sql` はエージェントが実行できない。ユーザーにSQL全文を提示して実行を依頼する
- 週データの書き込みは `updateWeekMine()` を通す(直接upsertすると他メンバーの編集を消す)
- 案件の `archived`/`lost` は廃止済み。`isOpenCase()`/`isOrderedCase()` 等を使う
- 権限判定は `app_metadata` で行う(`user_metadata` は本人が書き換えられる)
