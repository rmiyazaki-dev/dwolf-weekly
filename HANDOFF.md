# D-WOLF週次管理アプリ — 引き継ぎメモ (HANDOFF)

Claude Codeで作業を再開する際は、このファイルを最初に読んでください。

## 概要
- 清水組ドローン事業部(D-WOLF)向けの週次業務管理アプリ
- 単一HTMLファイル(Vanilla JS)+ Supabase(DB・Storage)+ Vercelホスティング
- 本番URL: https://dwolf-weekly-app.vercel.app
- リポジトリ: https://github.com/rmiyazaki-dev/dwolf-weekly (main ブランチ)
- 実体ファイル: `index.html` 1ファイルに全機能が入っている(HTML+CSS+JS)

## デプロイフロー
```
ローカルで index.html を編集
→ git add . && git commit -m "..." && git push origin main
→ GitHub連携によりVercelが自動デプロイ(1〜2分)
→ ブラウザで Cmd+Shift+R (強制リロード)して確認
```
robots.txt も同リポジトリのルートに置いてあり、検索エンジン除外用。

## Supabase構成
- プロジェクトURL・anon keyは index.html 冒頭の `SUPABASE_URL` / `SUPABASE_ANON_KEY` に直書き済み(社内限定ツールのため許容)
- テーブル作成SQLは `setup.sql`(基本) → `setup-v3.sql`(顧客・履歴・ファイル追加分)の順で実行済み
- 主なテーブル:
  - `kv`: 汎用キーバリュー(マスター設定 `master`、共通パスワード `app_password`、`settings` など)
  - `weeks`: 週次データ(week_key=YYYYMMDD、スケジュール・TODO・繁忙度・日報サマリー等をJSONBで1レコードに格納)
  - `cases`: 案件(id=タイムスタンプ、dataカラムにJSONBで詳細)
  - `customers`: 顧客マスタ
  - `case_history`: 案件の変更履歴タイムライン
  - `case_files`: Supabase Storage(`case-files`バケット、公開・50MB上限)のファイル台帳
  - `comments`: 案件コメント
  - `announcements`: 連絡事項(既読管理はreadsカラムのJSONB配列)
  - `audit_log`: 全体の更新履歴
  - `nippo`: 日報(Teamsから自動取込 or 手動送信、teams_msg_idで重複防止)

## 認証まわり
- アプリ自体: 名前選択 + 共通パスワード(初期値 `dwolf2026`、マスター管理タブから変更可能。試用段階のため簡易方式のまま継続する方針)
- Teams連携: Entra ID(Azure AD)にSPAアプリ登録済み(`DWOLF-Nippo-Reader`)。MSAL.js使用。権限: ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All, Calendars.Read
  - リダイレクトURIは固定値 `https://dwolf-weekly-app.vercel.app`(location.origin動的生成だと稀にAADSTS500111エラーが出たため固定化した経緯あり)
- Googleカレンダー連携: Google Identity Services使用。個人Gmailアカウント前提でOAuth同意画面は「外部」+テストユーザー登録方式

## 実装済み機能(v3.1時点)
1. 週間ボード: スケジュール入力、TODO、Outlook/Googleカレンダー自動取込、ICS手動取込
2. 案件管理: 顧客・見積額・受注額・請求状況・実施日・納期・コメント・ファイル添付・変更履歴
3. カンバンボード: ステータス別に案件を可視化、◀▶で移動
4. ダッシュボード: KPI集計(受注額・未請求額・入金済等)、分類別/担当別グラフ、今月実施一覧
5. 連絡事項: 掲示板+既読管理
6. 日報: Teamsチャネルから自動取込(Adaptive Card対応・メンション/Workflow添付文除去済み)、「会議資料に反映」ボタンで業務内容/相談事項を自動抽出し会議モード・社長報告に連携(手動編集可、再反映しても上書きしない設計)
7. 会議モード: 繁忙度、応援要否、日報サマリー(編集可)
8. 社長報告: A4印刷/PDF出力(週間スケジュール・案件・日報まとめ・決定事項)
9. マスター管理: メンバー・分類・ステータス・繁忙度・顧客マスタ・共通パスワード変更

## 既知の未対応・今後の検討事項
- セキュリティは共通パスワード方式のまま(Supabase Authへの切替は見送り中、必要になれば再検討)
- ファイルストレージは公開バケット(URL推測困難だが非公開ではない)。マイナンバー等の機微情報は上げない運用でカバー
- 「成清沙織」等、マスター未登録のメンバーが日報を出すと日報タブには出るが、スケジュール/案件/会議モードには反映されない(マスター管理で追加が必要)
- 日報の「業務内容」抽出は正規表現ベース(`業務内容：`〜`明日の予定`手前)。Teams側フォームの項目順が変わると抽出がずれる可能性あり

## 参考ドキュメント(すでにユーザーに渡し済み)
- `Googleカレンダー自動連携_設定手順書.pdf`(管理者向け)
- メンバー向け利用ガイドPDF(作成途中で本セッション終了。必要なら再開)

## 開発者(ユーザー)の環境・好み
- Mac、ターミナル操作は指示があれば実行できるレベル
- コマンドは1つずつ、エラー時は次の一手を具体的に提示する進め方を好む
- 資料はWord/PowerPoint/Excel/PDF納品を好み、Noto Sans JPフォント推奨
- 実装の詳細を削らず、細かい手順を維持したまま資料化してほしいとの要望あり
