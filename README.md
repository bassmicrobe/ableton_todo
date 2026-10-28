# Track Notes — Ableton Live Extension

**オーディオ／MIDI トラックを右クリックして、そのトラック専用のメモと TODO を書き留められる Ableton Live 拡張機能です。**

## 概要

トラックのタイトルバーを右クリック →「Track Notes…」でモーダルパネルが開き、メモ・TODO・履歴をタブで管理できます。データは Live プロジェクト単位の SQLite データベースに保存されます。

- **トラックごとのメモ**：自由記述のテキストエリア。最終更新日時を表示。
- **トラックごとの TODO**：追加／チェック（完了）／編集／削除。各項目に作成・更新日時。未完了が上に並びます。
- **トラック名の変更**：ヘッダーの名前欄を編集して保存すると、Live 側のトラック名も変更され、保存済みメモ／TODO も新しい名前へ移行します。
- **グループの子トラック一覧**：グループトラックの親で開くと「子トラック」タブが現れ、各子トラックのメモ／TODO を読み取り専用で一覧できます。
- **保存履歴**：保存するたびに「メモ＋TODO の全スナップショット」と日時・変更サマリを記録。履歴タブで展開して中身を確認でき、**「この状態を復元」**で過去の内容を呼び戻せます。
- **プロジェクト単位の分離**：Live プロジェクトごとに別々の SQLite データベース。別の曲を開けば別のメモ。
- **Live のダークテーマに馴染む UI**：タブ式（メモ／TODO／履歴／子トラック）、`Cmd/Ctrl+S` で保存、`Esc` でキャンセル。

## 技術スタック

- **言語／ランタイム**：TypeScript（Node.js 24.14.1 以上）
- **SDK**：`@ableton-extensions/sdk` 1.0.0-beta.0（beta、`vendor/` の tgz を同梱）
- **ビルド**：esbuild + tsx（`src/ui.html` を文字列としてインライン）
- **ストレージ**：Node 組み込みの `node:sqlite`（`DatabaseSync`）— ネイティブアドオンのビルド不要
- **UI**：WebView 上の単一 HTML（`showModalDialog()` の `data:` URL 方式）

## セットアップ

### 必要環境

- **Node.js 24.14.1 以上**（CLI 要件）。`node:sqlite` の安定版が必要です。
- **Ableton Live**（Extension 対応ビルド）。

### 1. 依存のインストール

```sh
npm install
```

> SDK/CLI は npm 非公開のため、`vendor/` 内の `.tgz` を `package.json` から参照しています。

### 2. Extension Host のパスを設定

`extensions-cli run` は `ExtensionHostNodeModule.node` の場所を `EXTENSION_HOST_PATH`（環境変数または `.env`）から読みます。

```sh
cp .env.example .env
# .env を編集して EXTENSION_HOST_PATH を設定
```

macOS の例：

```
EXTENSION_HOST_PATH=/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Extensions/ExtensionHostNodeModule.node
```

> 正確な場所は SDK 同梱ドキュメント（docs の development セクション）の「ExtensionHostNodeModule.node の見つけ方」を参照してください。

### 3. ビルドと実行

```sh
# 型チェック + バンドル（dist/extension.js を生成）
npm run build

# ビルドして Live の Extension Host で実行
npm start
```

`npm start` 後、Live でオーディオ／MIDI トラックを右クリック →「Track Notes…」。

VS Code が PATH にあれば、scaffold 同様に F5 デバッグ構成を追加できます（`extensions-cli run --inspect`）。

### 4. 配布パッケージ化

```sh
npm run package      # .ablx アーカイブを生成（本番ビルド）
```

## 構成

```
ableton_todo/
├── manifest.json          # 拡張メタデータ（name/author/entry/minimumApiVersion）
├── package.json           # スクリプトと依存（vendor の tgz を参照）
├── tsconfig.json          # 型チェック設定（公式サンプル準拠）
├── build.ts               # esbuild バンドル（.html を文字列としてインライン）
├── .env.example           # EXTENSION_HOST_PATH のひな型
├── docs/                  # 設計・仕様ドキュメント
├── vendor/                # SDK / CLI の beta tgz（リポジトリ自己完結のため同梱）
│   ├── ableton-extensions-sdk-1.0.0-beta.0.tgz
│   └── ableton-extensions-cli-1.0.0-beta.0.tgz
└── src/
    ├── extension.ts       # エントリ。コンテキストメニュー登録＆パネル制御
    ├── project.ts         # プロジェクト識別と DB パス解決
    ├── store.ts           # SQLite ストレージ（load/save、履歴、差分反映）
    ├── ui.html            # リッチ UI（3タブ・単一HTML）
    └── html.d.ts          # `import ui from "./ui.html"` の型宣言
```

## ドキュメント

- [設計と仕様](docs/設計と仕様.md) — アーキテクチャ、SQLite データモデル、既知の制約、今後の拡張アイデア

## ライセンス

`@ableton-extensions/sdk`（Ableton AG, beta）に依存します。SDK のライセンスは配布 zip 内 `LICENSE.md` を参照してください。
