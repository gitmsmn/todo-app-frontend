# todo-app-frontend

「大雑把なTODOをAIが分解・調査するTODOアプリ」のフロントエンド（公開リポジトリ）。

このリポジトリは**公開（public）**で、GitHub Pagesでの無料ホスティングのために静的ファイル（HTML/CSS/JS）のみを置く。バックエンド（Lambda/DynamoDB/Terraform）や詳細仕様（アーキテクチャ、データモデル、コスト試算等）は、非公開の companion リポジトリ（`todo-app-backend`）で管理している。このリポジトリには認証キー等の秘密情報を一切含めない（利用者が初回アクセス時に設定画面へ入力し、`localStorage`にのみ保存する運用）。

## 構成

```
index.html
style.css
app.js
```

ビルドステップなし。このリポジトリのルートがそのままGitHub Pages（Settings → Pages → Source: Deploy from a branch → main / (root)）で配信される。

## デプロイ

`main`ブランチにpushするだけで、GitHub PagesのURL（`https://<username>.github.io/todo-app-frontend/`）に反映される。ビルドステップが不要なため、GitHub Actionsは使用しない。

## 初回セットアップ（この端末でのAPIキー設定）

バックエンド（`todo-app-backend`）を`terraform apply`した後、以下の値をこのページの設定画面（右上の⚙）に貼り付ける。

```bash
terraform output -raw frontend_config
```

Lambda関数URLはAPIごとに別々のURLになるため（API Gatewayのパスルーティングを使っていない）、`frontend_config`は`apiKey`と6つのURLをまとめた1つのJSONになっている。貼り付けた内容は`localStorage`にのみ保存される（デバイスごとに1回でよい）。

## 実装状況（Phase 1）

- `index.html` / `style.css`: モバイルファーストのレイアウト、入力フォーム、一覧、設定ダイアログ
- `app.js`: API呼び出し、タイトル・ステップ・調査要約のインライン編集、完了状態の切り替え、論理削除、簡易Markdownレンダリング（調査結果の表示用）

再生成（`regenerate`）はPhase 2で対応する。
