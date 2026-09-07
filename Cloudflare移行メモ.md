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

## 参考

同じ手法での移行実績: `会社基盤/products/印鑑販売_行政書士様向け/Cloudflare移行メモ.md`
