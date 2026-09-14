# D-BORD 1on1

隔月・30分の面談を、既存D-BORD内の独立メニューで扱う。

## 公開と利用開始

コードの公開と、面談情報の受付開始は別に扱う。`ONEONONE_ENABLED` が `true` でなければメニューを表示せず、専用保存先にも接続しない。`ONEONONE_LIVE_APPROVED` は保存運用・権限・外部接続の検証が終わるまで設定しない。

専用DBの初期設定、対象者の個人ログインIDの照合、保存期間・削除運用、本人への周知が必要。SQLと実際のアカウント対応表は社内資料として別管理する。共有管理アカウントには面談データの権限を付与しない。

## 通知先の非公開設定

- `ONEONONE_TEAMS_MANAGER`: 確認済みの面談担当者の清水組アドレス。
- `ONEONONE_TEAMS_RECIPIENTS`: 確認済み社員4名のアドレスをキー、表示名を値とするJSONオブジェクト。
- `ONEONONE_TEAMS_WEBHOOK` / `ONEONONE_TEAMS_SECRET`: 通知フローの署名付きURLと追加の共有秘密値。
- `ONEONONE_TEAMS_MODE`: 標準のTeamsカードフローは `workflows`。
- `ONEONONE_TEAMS_FLOW_URL`: 担当者用の実行履歴URL。
- `ONEONONE_APP_ORIGIN`: D-BORDの公開HTTPS origin。
- `ONEONONE_COPROS_MAILBOX`: 本人のコプロス予定表アカウント。Teams側へ代替しない。

通知先未設定・不正なら送信しない。HTTP 202は受付済み・配信未確認とし、再送を拒否する。外部フローの実行履歴で確認する。回答・満足度・分析は通知に含めない。

予定表・AI・定期実行はそれぞれ別途設定と検証が必要。秘密値や社員情報をGitへ追加しない。内部ソース・社内資料・開発用データはWeb配信しない。

## 公開前の最低限の検証

`node --test tests/oneonone-release.test.js`

加えて社内管理の全テスト、既存12画面、権限別画面、実DBの権限制限を確認する。模擬テストを本番接続済みとは扱わない。
