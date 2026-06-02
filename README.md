# Track Notes & TODO — Ableton Live Extension

オーディオ／MIDI トラックを右クリックして、**そのトラック専用のメモと TODO** を書き留められる Ableton Live 拡張機能です。保存ごとに日時が記録され、過去の状態を**履歴として閲覧・復元**できます。データは **SQLite** に、**Live プロジェクト単位**で保存されます。

> Built with `@ableton-extensions/sdk` 1.0.0-beta.0（beta）。

---

## 目次

- [機能](#機能)
- [スクリーンショット的な動作イメージ](#スクリーンショット的な動作イメージ)
- [アーキテクチャ](#アーキテクチャ)
- [データモデル](#データモデル)
- [ファイル構成](#ファイル構成)
- [セットアップ](#セットアップ)
- [ビルドと実行](#ビルドと実行)
- [配布パッケージ化](#配布パッケージ化)
- [仕様と既知の制約](#仕様と既知の制約)
- [今後の拡張アイデア](#今後の拡張アイデア)

---

## 機能

- **トラックごとのメモ**：自由記述のテキストエリア。最終更新日時を表示。
- **トラックごとの TODO**：追加／チェック（完了）／編集／削除。各項目に作成・更新日時。未完了が上に並びます。
- **保存履歴**：保存するたびに「メモ＋TODO の全スナップショット」と日時・変更サマリを記録。履歴タブで展開して中身を確認でき、**「この状態を復元」**で過去の内容を呼び戻せます。
- **プロジェクト単位の分離**：Live プロジェクトごとに別々の SQLite データベース。別の曲を開けば別のメモ。
- **Live のダークテーマに馴染む UI**：3 タブ（メモ／TODO／履歴）、`Cmd/Ctrl+S` で保存、`Esc` でキャンセル。

## スクリーンショット的な動作イメージ

1. Live のセッション／アレンジ画面で、オーディオまたは MIDI トラックのタイトルバーを右クリック。
2. コンテキストメニューの **「Notes & TODO…」** を選択。
3. モーダルパネルが開く：
   - **メモ** タブ … トラックの覚え書き。
   - **TODO** タブ … 「ミックス調整」「サンプル差し替え」などのタスク。
   - **履歴** タブ … いつ何を保存したかの一覧。展開して過去のメモ／TODO を確認・復元。
4. **保存** で SQLite に書き込み、履歴に 1 件追加。**キャンセル**または `Esc` で破棄。

---

## アーキテクチャ

このSDKのモーダルダイアログは「開く→閉じる時に文字列を1つ返す」**単発往復モデル**です（公式 `modal-dialog` サンプルと同じ `data:` URL 方式）。本拡張もこれに沿っています。

```
┌──────────────── Extension (Node.js / dist/extension.js) ─────────────────┐
│ activate()                                                               │
│   └─ registerContextMenuAction("AudioTrack"/"MidiTrack", "Notes & TODO…")│
│   └─ registerCommand("trackNotes.open")                                  │
│                                                                          │
│ openPanel(handle):                                                       │
│   1. handle → Track（getObjectFromHandle）→ track.name                    │
│   2. resolveProject()  …… プロジェクト用 SQLite のパスを決定（project.ts）  │
│   3. store.loadTrack() …… メモ/TODO/履歴を読み出し（store.ts, SQLite）     │
│   4. ui.html に初期状態(JSON)を差し込み、data: URL で showModalDialog()    │
│   5. 閉じたら返り値(JSON)を受け取り、save なら store.saveTrack()           │
└──────────────────────────────────────────────────────────────────────────┘
                                  ▲ 初期状態(JSON)         │ 返り値(JSON: action/memo/todos)
                                  │                        ▼
┌──────────────── WebView UI (src/ui.html, 単一HTML) ──────────────────────┐
│ メモ / TODO / 履歴 の3タブ。編集はすべてメモリ上のモデルで管理し、         │
│ 「保存」時に現在の全状態を JSON で host に postMessage して閉じる。        │
└──────────────────────────────────────────────────────────────────────────┘
```

### ポイント

- **UI ↔ Extension の通信**：UI は `window.webkit.messageHandlers.live`（macOS）または `window.chrome.webview`（Windows）に `{ method: "close_and_send", params: [JSON] }` を送って閉じます。返ってくる JSON が `showModalDialog()` の解決値です。
- **タイムスタンプは Extension 側で付与**：保存日時・作成/更新日時は Node 側で `new Date().toISOString()`（ISO-8601, UTC）で確定します。WebView の時計には依存しません。
- **保存は1トランザクション**：メモの upsert、TODO の差分反映（追加／更新／削除）、履歴スナップショットの追記を `BEGIN…COMMIT` でまとめ、失敗時は `ROLLBACK`。

---

## データモデル

`@ableton-extensions/sdk` には「現在の Live Set のパス／ID を取得する API」が**存在しません**。そこで本拡張は次の方法でプロジェクトを識別します（`src/project.ts`）：

1. 一時ファイル（マーカー）を作成。
2. `resources.importIntoProject(marker)` でそれを**現在のプロジェクトフォルダへコピー**。返り値はコピー先の絶対パス。
3. そのフォルダパスの SHA-256 先頭16文字を **プロジェクトキー** とする。
4. データベースは拡張の `environment.storageDirectory/projects/<projectKey>.sqlite` に置く（書き込みが常に保証される拡張専用領域。ユーザのプロジェクトツリーは汚さない）。

> プロジェクト未保存・インポート不可の場合は、共有の `default.sqlite` にフォールバックします。

### SQLite スキーマ（プロジェクト DB ごと）

トラックは**トラック名**でキー化されます（`track_key`）。日時はすべて ISO-8601（例：`2026-06-03T09:00:00.000Z`）。

```sql
-- トラックのレジストリ
tracks(
  track_key TEXT PRIMARY KEY,   -- 正規化したトラック名
  name TEXT, created_at TEXT, updated_at TEXT
)

-- 1トラック1メモ
memos(
  track_key TEXT PRIMARY KEY,
  text TEXT, updated_at TEXT
)

-- TODO 項目
todos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_key TEXT, text TEXT,
  done INTEGER,                 -- 0 / 1
  created_at TEXT, updated_at TEXT
)

-- 保存ごとのスナップショット（履歴）
history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_key TEXT, saved_at TEXT,
  memo_snapshot TEXT,
  todos_snapshot TEXT,          -- JSON 文字列
  summary TEXT                  -- 例: "memo updated, +1 todo · 3 total"
)
```

ストレージは Node 組み込みの **`node:sqlite`（`DatabaseSync`）** を使用。ネイティブアドオンのビルドが不要なので、Extension Host の Node ABI に依存しません。

---

## ファイル構成

```
ableton_todo/
├── manifest.json          # 拡張メタデータ（name/author/entry/minimumApiVersion）
├── package.json           # スクリプトと依存（vendor の tgz を参照）
├── tsconfig.json          # 型チェック設定（公式サンプル準拠）
├── build.ts               # esbuild バンドル（.html を文字列としてインライン）
├── .env.example           # EXTENSION_HOST_PATH のひな型
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

---

## セットアップ

### 必要環境

- **Node.js 24.14.1 以上**（CLI 要件）。`node:sqlite` の安定版が必要です。
- **Ableton Live**（Extension 対応ビルド）。

### 1. 依存のインストール

```sh
cd ableton_todo
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

---

## ビルドと実行

```sh
# 型チェック + バンドル（dist/extension.js を生成）
npm run build

# ビルドして Live の Extension Host で実行
npm start
```

`npm start` 後、Live でオーディオ／MIDI トラックを右クリック →「Notes & TODO…」。

### デバッグ

VS Code が PATH にあれば、scaffold 同様に F5 デバッグ構成を追加できます（`extensions-cli run --inspect`）。

---

## 配布パッケージ化

```sh
npm run package      # .ablx アーカイブを生成（本番ビルド）
```

---

## 仕様と既知の制約

このSDKは **beta** であり、いくつかの制約があります。設計上の割り切りを明記します。

- **トラックの識別はトラック名**：SDK は安定したトラック ID をプロジェクト保存後に提供しません（`Handle.id` はセッション内のみ有効）。そのため `track_key = トラック名`。
  - 影響：**トラックをリネームすると、そのトラックのメモ／TODO は引き継がれません**（旧名のまま DB に残ります）。
  - 同名トラックが2つあると、メモ／TODO を共有します。
- **プロジェクト識別の副作用**：`importIntoProject` を使うため、初回プローブ時に**小さなマーカーファイルがプロジェクトへ取り込まれます**（`track-notes-probe.txt`、削除可）。
  - フォールバック：プロジェクト未保存／インポート不可なら共有 DB（`default.sqlite`）。
  - セッション中の「名前を付けて保存（別フォルダ）」はその場では再検出されません（Live 再起動で反映）。
- **保存はダイアログを閉じた時のみ**：モーダルが単発往復モデルのため、リアルタイム自動保存ではありません。`Cmd/Ctrl+S` または「保存」ボタンで確定。
- **`node:sqlite` 依存**：Extension Host の Node に `node:sqlite` が含まれている必要があります（Node 24 系で安定提供）。

---

## 今後の拡張アイデア

- **リネーム追従**：リネーム検知時に旧キーのメモ／TODO を移行する UI。
- **全トラック横断ビュー**：プロジェクト内の全 TODO を一覧する集約パネル（モーダルではなく localhost サーバ方式に切り替えるとリアルタイム化も可能）。
- **クリップ／シーン単位のメモ**：コンテキストメニューのスコープを `MidiClip` / `AudioClip` / `Scene` へ拡張。
- **エクスポート**：メモ／TODO を Markdown や CSV へ書き出し。
- **検索・タグ付け**：TODO のフィルタ（未完了のみ等）やタグ。

---

## ライセンス / クレジット

`@ableton-extensions/sdk`（Ableton AG, beta）に依存します。SDK のライセンスは配布 zip 内 `LICENSE.md` を参照してください。
