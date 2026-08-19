# D-WOLF週次管理アプリ — 引き継ぎメモ (HANDOFF)

Claude Codeで作業を再開する際は、このファイルを最初に読んでください。

## 概要
- 清水組ドローン事業部(D-WOLF)向けの週次業務管理アプリ
- フロントエンドは単一HTMLファイル(Vanilla JS)+ Supabase(DB・Storage)+ Vercelホスティング
- v3.3でMoney Forward連携用に**初のバックエンド**(Vercel Serverless Functions、`api/`・`lib/`配下)を追加。フロントエンド(index.html)自体は引き続きバックエンドなしの構成
- 本番URL: https://dwolf-weekly-app.vercel.app
- リポジトリ: https://github.com/rmiyazaki-dev/dwolf-weekly (main ブランチ)
- 実体ファイル: `index.html`(画面本体)、`api/mf/*.js`・`lib/mf/*.js`(Money Forward連携のサーバーレス関数)、`vercel.json`(Cron設定)、`package.json`(Node実行環境)

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
- テーブル作成SQLは `setup.sql`(基本) → `setup-v3.sql`(顧客・履歴・ファイル追加分) → `setup-mf.sql`(Money Forward連携分)の順で実行(setup-mf.sqlは未実行、下記「Money Forward連携」参照)
- 主なテーブル:
  - `kv`: 汎用キーバリュー(マスター設定 `master`、共通パスワード `app_password`、`settings`、同期状態 `mf_sync_state` など)
  - `weeks`: 週次データ(week_key=YYYYMMDD、スケジュール・TODO・繁忙度・日報サマリー等をJSONBで1レコードに格納)
  - `cases`: 案件(id=タイムスタンプ、dataカラムにJSONBで詳細。`mfQuoteId`/`mfBillingId`/`mfLinkedAt`はMF連携で自動付与)
  - `customers`: 顧客マスタ
  - `case_history`: 案件の変更履歴タイムライン
  - `case_files`: Supabase Storage(`case-files`バケット、公開・50MB上限)のファイル台帳
  - `comments`: 案件コメント
  - `announcements`: 連絡事項(既読管理はreadsカラムのJSONB配列)
  - `audit_log`: 全体の更新履歴
  - `nippo`: 日報(Teamsから自動取込 or 手動送信、teams_msg_idで重複防止)
  - `mf_tokens`(v3.3で追加): MFのOAuthトークン保管専用。**RLS有効・anon/authenticatedへのポリシーなし**。service_role keyのみアクセス可(index.htmlの通常運用とは別扱い)
  - `mf_review_queue`(v3.3で追加): MFの見積書/請求書のうち自動突合できなかったものの一覧。他テーブル同様anon keyで読み書き

## 認証まわり
- アプリ自体: 名前選択 + 共通パスワード(初期値 `dwolf2026`、マスター管理タブから変更可能。試用段階のため簡易方式のまま継続する方針)
- Teams連携: Entra ID(Azure AD)にSPAアプリ登録済み(`DWOLF-Nippo-Reader`)。MSAL.js使用。権限: ChannelMessage.Read.All, Team.ReadBasic.All, Channel.ReadBasic.All, Calendars.Read
  - リダイレクトURIは固定値 `https://dwolf-weekly-app.vercel.app`(location.origin動的生成だと稀にAADSTS500111エラーが出たため固定化した経緯あり)
- Googleカレンダー連携: Google Identity Services使用。個人Gmailアカウント前提でOAuth同意画面は「外部」+テストユーザー登録方式

## 実装済み機能(v3.2時点)
1. 週間ボード: スケジュール入力、TODO、Outlook/Googleカレンダー自動取込、ICS手動取込
2. 案件管理: 顧客・見積額・受注額・請求状況・実施日・納期・**入金予定日**・コメント・ファイル添付・変更履歴
3. カンバンボード: ステータス別に案件を可視化、◀▶で移動
4. ダッシュボード: KPI集計(受注額・未請求額・入金済等)、**期・月次の受注/売上予測**、分類別/担当別グラフ、今月実施一覧
5. 連絡事項: 掲示板+既読管理
6. 日報: Teamsチャネルから自動取込(Adaptive Card対応・メンション/Workflow添付文除去済み)、「会議資料に反映」ボタンで業務内容/相談事項を自動抽出し会議モード・社長報告に連携(手動編集可、再反映しても上書きしない設計)
7. 会議モード: 繁忙度、応援要否、日報サマリー(編集可)
8. 社長報告: A4印刷/PDF出力(週間スケジュール・案件・日報まとめ・決定事項)
9. マスター管理: メンバー・分類・ステータス・繁忙度・顧客マスタ・共通パスワード変更。メンバー/分類/ステータス/繁忙度は**ドラッグ&ドロップ(＋▲▼ボタン)で並び替え可能**
10. Money Forwardクラウド請求書 連携(v3.3・未セットアップ): MFの見積書作成→案件と自動突合(できなければ案件管理タブの「要確認リスト」で人が手動紐付け)、請求書発行/入金確認→案件の請求状況(billingStatus)のみ自動更新。設定タブに連携カードあり

## v3.2で追加した仕様の要点
- **決算期は6月末締め**。会計年度は7月開始〜翌年6月終了で、`FY_START_MONTH = 7` を変えれば決算月を変更できる
- ダッシュボードの「期・月次の受注/売上(予測)」
  - 期はプルダウンで切替。データが存在する期＋今期が自動で選択肢に出る
  - **受注額**の計上月 = 実施日 →(なければ)納期 →(なければ)入金予定日(`orderBaseDate()`)
  - **売上予測(入金予定)** = 入金予定日ベース。うち請求状況が「入金済」のものが実績
  - **見込(見積)** = 進行中かつ受注額未入力で見積額のある案件(受注前パイプライン)
  - 金額集計は完了(アーカイブ)済も含む。進行中のみのKPIは従来どおり上段に表示
  - 受注済なのに入金予定日が未設定の案件は警告バナーで件数・金額を表示(予測から漏れるため)
  - 期別サマリーで全期の受注額・入金予定・入金済を横並び比較
- マスターの並び替えは `master` JSONの配列順を直接入れ替えて`kv`に保存。ステータス順はカンバンの列順、メンバー順は週間ボード/会議モード/社長報告の行順にそのまま反映される
- 案件の`paymentDate`(入金予定日)はDBスキーマ変更不要(`cases.data` JSONBに追加されるだけ)。**SQLの追加実行は不要**

## Money Forwardクラウド請求書 連携(v3.3・要セットアップ)
コードは実装・テスト済みだが、**本番で使うには下記のセットアップがまだ必要**(未実施)。

### アーキテクチャ
- index.html(ブラウザ)はMFのclient_secretに触れない。`api/mf/*.js`(Vercel Serverless Functions)がOAuth・ポーリング同期を担当する、このプロジェクト初のバックエンド
- `mf_tokens`テーブルはRLS有効・ポリシーなしにしてあり、`SUPABASE_SERVICE_ROLE_KEY`を持つサーバー側コードだけがアクセスできる(refresh_tokenは会社の請求書・入金データに触れるベアラー資格情報のため、他の設定値より一段階強く保護している)
- Webhookは確認できなかったためポーリング方式。Vercel Cron(`vercel.json`、`0 * * * *`=1時間毎)+ 設定タブの「今すぐ同期」ボタン(手動トリガー、追加認証なし。社内限定ツールという既存運用に合わせた設計)

### 業務ルール(ヒアリング済み・実装反映済み)
1. MFの見積書は既存案件(顧客名+金額で突合)と自動マッチング。**一意に決まらない場合は自動で新規案件を作らず「要確認リスト」**(案件管理タブ)に出す
2. MFで請求書発行 → 案件の**請求状況(billingStatus)のみ**「請求済」に自動更新。進捗ステータス(カンバン列)は動かさない
3. MFで入金確認 → **billingStatusのみ**「入金済」に自動更新。進捗ステータス・入金予定日(paymentDate)は変更しない(手入力データを壊さないため)

### ファイル構成
- `lib/mf/fieldMap.js`: **MFのレスポンスJSONフィールド名を吸収する層。実データ未確認のため、ここに全集約**(`extractQuoteFields`/`extractBillingFields`/`normalizePartnerName`/`isPaid`/`amountsClose`)。本番接続後にフィールド名がズレていたら、このファイルだけ直せばよい設計
- `lib/mf/mfClient.js`: MFのOAuth(認可URL生成・トークン交換・リフレッシュ)、quotes/billings一覧のページング取得
- `lib/mf/supabaseAdmin.js`: `mf_tokens`専用、service_role key使用
- `lib/mf/supabaseAnon.js`: `cases`/`case_history`/`audit_log`/`mf_review_queue`/`kv`用、anon key使用
- `api/mf/authorize.js` → `callback.js` → `status.js`: OAuth連携フロー一式
- `api/mf/sync.js`: 同期本体(突合・要確認キュー登録・billingStatus更新)。`Authorization: Bearer $CRON_SECRET`(Cron用)または`?manual=1`(手動ボタン用)で起動
- `setup-mf.sql`: `mf_tokens`・`mf_review_queue`のCREATE TABLE(**Supabaseで未実行**)

### セットアップ手順(次回作業時にここから)
1. MFクラウド請求書 → 歯車アイコン →「API連携β(開発者向け)」→ 新規作成。Redirect URI: `https://dwolf-weekly-app.vercel.app/api/mf/callback`、Scope: `mfc/invoice/data.read`。発行されたclient_id/secretを控える
2. Vercelプロジェクトの環境変数(Production)に追加: `MF_CLIENT_ID` / `MF_CLIENT_SECRET` / `CRON_SECRET`(ランダム値、自分で生成) / `SUPABASE_URL` / `SUPABASE_ANON_KEY`(index.html内と同じ値を転記) / `SUPABASE_SERVICE_ROLE_KEY`(Supabase→Project Settings→API。**index.htmlには絶対に貼らない**)
3. Supabase SQL Editorで`setup-mf.sql`を実行
4. デプロイ後、設定タブ「連携する」→ MF側の同意画面で許可 → `mfCfgState`に事業者名が出れば成功
5. 「今すぐ同期」を押して実データを取得。もし見積・請求の金額や取引先名が正しく取れていなければ、`lib/mf/fieldMap.js`のキー名を実際のレスポンスに合わせて修正して再デプロイ

### 検証状況
- `lib/mf/fieldMap.js`の正規化ロジック(全角半角統一等)、`api/mf/sync.js`の突合・要確認キュー登録・billingStatus更新ロジックは、fetchをモックしたNode統合テストで一通り確認済み(ローカルではMFの実APIには接続できないため)
- index.htmlの要確認リストUI・紐付け/見送り・設定タブの連携カードは、ローカルSupabaseスタブでのブラウザ実機テストで動作確認済み
- OAuth疎通・実データでのフィールド名の正しさは、本番セットアップ後でないと確認できない(既知のリスクとして`fieldMap.js`に集約済み)

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
