# AGENTS.md — このリポジトリでの作業ルール

D-BORD(清水組ドローン事業部 D-WOLF の週次業務管理アプリ)のエージェント向け指示書。
Codex / Claude Code など、どのエージェントでもこのファイルを最初に読むこと。

- **機能・仕様・過去の経緯の詳細は [HANDOFF.md](HANDOFF.md)** を参照(作業前に必ず目を通す)
- 本番URL: https://dwolf-weekly-app.vercel.app
- リポジトリ: https://github.com/rmiyazaki-dev/dwolf-weekly (main ブランチ)

---

## 1. まず知っておくべき構成

```
index.html          画面本体。HTML+CSS+JSが1ファイルに全部入り(約25万文字)。
                    フレームワーク・ビルド不要。末尾の大きな <script> が全ロジック。
api/mf/*.js         Money Forward連携のVercel Serverless Functions(OAuth・同期)
lib/mf/*.js         MF連携の共通処理(APIクライアント・フィールド正規化・DBアクセス)
setup-*.sql         Supabaseで手動実行するSQL(自動実行される仕組みは無い)
rename-member.sql   メンバー改名時に使う一括置換SQL
logo.png            ヘッダー・ログイン画面のロゴ
vercel.json         Cron設定(MF同期。1日1回)
```

**ビルド工程もテストランナーも無い。** `npm install` も不要(`package.json`はNodeバージョン指定のみ)。

## 2. 変更→反映の流れ

```bash
# index.html などを編集
git add . && git commit -m "..." && git push origin main
# → GitHub連携でVercelが自動デプロイ(1〜2分)
# → ブラウザで Cmd+Shift+R (強制リロード)して確認
```

`main`に push した時点で本番に出る。**ブランチ運用もステージング環境も無い**ので、
push前に必ず後述の検証を通すこと。

## 3. 変更前に必ず守ること

### 3-1. 構文チェック(必須)

`index.html`はビルドされないため、構文エラーがあっても push は通り、
**本番で画面が真っ白になる**。編集後は必ずこれを実行する:

```bash
python3 -c "
s=open('index.html').read()
i=s.rindex('<script>'); j=s.rindex('</script>')
open('/tmp/app.js','w').write(s[i+8:j])
"
node --check /tmp/app.js
```

`api/`・`lib/`を触った場合は `node --check <file>` も実行する。

### 3-2. ブラウザ実機テスト(UIを変えたとき)

Supabaseに接続せずローカルで動かすため、`window.supabase`を差し替えるスタブを使う。
このスタブはリポジトリに含めていない(すぐ陳腐化するため)。必要になったら作る:

1. `stub.js` を作る。`window.supabase = { createClient: () => ({ auth, from, storage }) }`
   を実装し、メモリ上の `DB` オブジェクトを読み書きする
   - `auth`: `getSession` / `signInWithPassword` / `signOut` を模擬。
     セッションが無ければ throw して **RLSを再現する**(未ログインでデータが読めないこと)
   - `from(table)`: `select/eq/in/gte/lte/order/limit/single/maybeSingle/upsert/insert/update/delete`
     をチェーン可能に実装
2. `index.html` をコピーして、CDNの `supabase-js` の `<script>` を `stub.js` に差し替えた
   `test.html` を作る(MSAL・Google GSI の `<script>` は削除)
3. `python3 -m http.server 8899` で配信し、ブラウザで開いて検証する

**検証は必ず「全12タブを順に開いてエラーが出ないこと」+「コンソールにエラーが無いこと」
まで含める。** 1箇所の変更が他タブの描画を壊すことが実際に何度もあった。

### 3-3. バックエンド(MF連携)を触ったとき

`global.fetch` をモックしてNodeで直接叩く統合テストを書く。MF API・Supabase REST の
両方を同じモックで捌ける。**実際にMF本番APIを叩いてテストしないこと。**

## 4. このコードベース特有の落とし穴

必ず守る。いずれも過去に実際バグを出した箇所。

| 対象 | ルール |
|---|---|
| 週データ(`weeks`) | 全員分が1レコードのJSONBに入っている。書き込みは必ず `updateWeekMine()` を通す。直接 upsert すると他メンバーの同時編集を消す |
| 週データに項目追加 | `ensureWeek()` はキーのホワイトリスト方式。追加したキーを `ensureWeek` に書かないと読み込み時に捨てられる |
| 案件の終了状態 | `archived`/`lost` は**廃止済み**。`isOpenCase()`/`isDoneCase()`/`isLostCase()`/`isClosedCase()` を使う |
| 受注の判定 | 金額集計は必ず `isOrderedCase()`(=失注でない かつ 受注額>0)を使う。失注案件を売上に含めない |
| 氏名 | `me`(表示名)が案件の担当・予定表のキー・投稿者など各所に**文字列として**保存される。改名は `rename-member.sql` |
| 権限判定 | `app_metadata`(本人が書き換え不可)で判定する。`user_metadata` は本人が書き換えられるので**絶対に権限判定に使わない** |
| サーバー側のDB | RLSが有効なので `lib/mf/supabaseAnon.js` は `SUPABASE_SERVICE_ROLE_KEY` を使う(anon keyでは弾かれる) |
| タブ再描画 | タブ切替のたびに `innerHTML` で作り直される。要素に付けたイベントや状態は毎回貼り直す必要がある |
| モーダルの位置 | モーダルは `.container` の外・`<body>` 直下にある。DOM監視の対象を `.container` にすると拾えない |

## 5. SQLの扱い

- `setup-*.sql` は**エージェントが実行できない**。ユーザーがSupabaseのSQL Editorに
  貼り付けて実行する。SQLを追加・変更したら、**チャットに全文を提示して実行を依頼する**
- 破壊的な操作(RLS変更・データ移行)は「①事前確認 → ②実行 → ③事後確認」の3段構成にし、
  空振りしても安全(冪等)に書く
- 実行状況は HANDOFF.md の「Supabase構成」に記録する

## 6. コードの書き方

- 既存コードの書き方に合わせる。**フレームワーク・ビルドツール・npmパッケージを新たに導入しない**
- コメントは日本語。**「何をしているか」ではなく「なぜそうしているか」**を書く
  (特に上記の落とし穴を回避している箇所は、理由を書かないと将来また踏む)
- 画面の文言・UIラベルはすべて日本語

## 7. ユーザーとのやり取り

- 日本語で応答する
- ユーザーは非エンジニア。**手順は1つずつ、具体的に**示す
- 動かないもの・未検証のものを「できました」と言わない。テストで確認した範囲を正確に伝える
- 仕様の判断が必要なとき(集計の定義・権限の範囲など)は、勝手に決めず先に確認する
