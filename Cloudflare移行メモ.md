# GitHub Pages → Cloudflare Pages 移行メモ

作成日: 2026-09-08
対象: プルデンシャル生命保険様向けスタンプ注文フォーム(シャイニー)の表側静的サイト。
`GAS_プルデンシャル版_API/`(裏側処理・注文台帳)は変更なし。

## 背景

商用の注文フォームをGitHub Pagesで公開していたことによる利用規約上のリスク回避のため、
無料のまま商用利用でき転送量が無制限のCloudflare Pagesへ移行した(印鑑注文フォームで先行実施した手法を踏襲)。

## 事前確認

移行前に「未コミットの価格改定があるかもしれない」という社長確認待ちの報告があったが、
着手時点で`git status`はクリーン(未コミット差分なし)だったため、
**リポジトリにコミット・push済みの`docs/index.html`の内容をそのままデプロイした**(最新かつpush済みの状態と判断)。

## 1. 現状構成の確認結果

- 表側は`docs/index.html`の1ファイルのみ
- `grep -rn '\.\./'`で親ディレクトリ参照が無いことを確認済み → 単独でそのままCloudflare Pagesに載せ替え可能
- `netlify.toml`等のホスティング固有設定ファイルは無し

## 2. Cloudflare Pages側の設定値

| プロジェクト名 | Production branch | Build output directory |
|---|---|---|
| `f3-prudential-stamp-order` | `main` | `docs` |

CLIでの直接デプロイ方式(GitHub連携は今回未実施)。コマンド:

```
npx wrangler pages project create f3-prudential-stamp-order --production-branch=main
npx wrangler pages deploy docs --project-name=f3-prudential-stamp-order --branch=main --commit-dirty=true
```

**ダッシュボードでのGitHub連携は未実施のため、今後`docs/index.html`を更新しても自動では反映されない。**
更新のたびに上記の`wrangler pages deploy`を再実行するか、後日ダッシュボードで「Connect to Git」を設定すること。

## 3. 実機確認結果(2026-09-08)

| 項目 | 結果 |
|---|---|
| 新URL | https://f3-prudential-stamp-order.pages.dev |
| HTTPステータス | 200 |
| タイトル | 住所印スタンプ ご注文フォーム |

## 4. 旧ホスティング(GitHub Pages)の状況

| 項目 | 結果 |
|---|---|
| URL | https://ria1107.github.io/prudential-stamp-order-form/(README.md記載の案内URL) |
| 状態 | 稼働中(HTTPステータス200、今回は停止していない) |

→ 今回は新旧並行稼働。GitHub Pages側の停止・削除は社長の最終確認後に別途対応する。

## 5. 残作業

1. 案内URLをどのタイミングで`f3-prudential-stamp-order.pages.dev`(または独自ドメイン)に切り替えるか社長と相談
2. README.mdの案内URL・Notion「DB_アプリURL台帳」の更新
3. 問題なければGitHub Pages側の停止(今回は未実施・指示があるまで着手しない)

## 6. 障害発生と調査結果(2026-09-14)

社長より「https://f3-prudential-stamp-order.pages.dev/ が添付画像のようになっている」と報告
(添付画像は見出し「3. メールアドレス」・クリーム色の装飾フォントデザイン)。

**調査結果**:
- 本番URL(`https://f3-prudential-stamp-order.pages.dev/`)にアクセスすると、curl・ヘッドレスブラウザ
  いずれも**Cloudflare自身の「Suspected Phishing(フィッシング詐欺の疑いあり)」警告画面**が
  100%表示され、フォームに到達できない状態を確認(Turnstile認証を解いて手動で突破する経路はあるが、
  一般のお客様がそこまでするとは考えにくい)
- 過去3回分のデプロイ個別URL(`https://<hash>.f3-prudential-stamp-order.pages.dev`)を直接確認したところ、
  **いずれも正しい「住所印スタンプ ご注文フォーム」の内容**で、「3. メールアドレス」のような見出しは
  存在しなかった。デプロイされている中身自体に問題はない
- 添付画像の「3. メールアドレス」という見出しは、同時期に別案件で改修中だった
  「らくぽん」注文フォーム(`プロジェクト/F3/20260822_ゴルフグッズ通販サイト構築/site/order.html`)の
  実際の見出しと完全一致した。このCloudflareプロジェクトへの誤デプロイの形跡は無かったため、
  添付画像は別タブ(らくぽん側)のスクリーンショットが混在した可能性が高いと判断(未確定)
- **README.mdの「お客様に共有するURL」は今も旧来のGitHub Pages版
  (`https://ria1107.github.io/prudential-stamp-order-form/`)のまま**で、Cloudflare版への切替は
  未実施だったと判明。GitHub Pages版は現在も200 OKで正常稼働のため、**実際のお客様への影響は無い**
- Web検索で確認: `*.pages.dev`共有ドメインはフィッシング業者に悪用されやすく、無関係な正規サイトが
  誤検知で巻き込まれる事例が多数報告されている既知の問題([Cloudflare Community](https://community.cloudflare.com/t/false-positive-report-for-suspected-phishing/909578)ほか)

**未解決**: フィッシング誤判定の解除には、Cloudflareダッシュボードへのログイン(アカウント所有者)から
「レビュー申請」を行う必要があり、wrangler CLIからは解除できない。対応方針は社長確認待ち
(このままGitHub Pages運用を継続する／ダッシュボードから異議申し立てをする／独自ドメインに変更する 等)。

## 参考

同じ手法での移行実績: `会社基盤/products/印鑑販売_行政書士様向け/Cloudflare移行メモ.md`
