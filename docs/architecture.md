# Cloakroom アーキテクチャ / コードリーディングガイド

`src/` を初めて読む人向けの地図。HTTP サーバ、API ごとの処理、PII のコアロジックを分けて配置している。

## 0. 読む順番

コメントが少ないので、闇雲に開くと迷子になる。この順で追うと全体像が繋がる。

以下のパスは `src/` からの相対パス。

| 順 | ファイル | 何が分かるか |
|---|---|---|
| 1 | `server.ts` → `server/runtime.ts` → `server/app.ts` | 起動と HTTP リクエストの分岐 |
| 2 | `server/proxy.ts` → `api/index.ts` | 上流への転送と API ごとの処理の選択 |
| 3 | `core/piiFilter.ts` | マスクと復元の司令塔 |
| 4 | `core/regexFilter.ts` の `applyReplacements` / `selectNonOverlappingMatches` | 「検出結果をどう本文に適用するか」 |
| 5 | `core/mappingTable.ts` | 番号札の発番と引き換え |
| 6 | `api/messages/streamRestorer.ts` / `api/completions/streamRestorer.ts` + `core/textDeltaRestorer.ts` | SSE の途中で切れたプレースホルダの扱い |
| 7 | `core/fpe.ts` / `core/fpeCodec.ts` | ステートレス可逆マスク |

残りは周辺（設定・CLI・統計・監査ログ）なので、必要になってから読めばいい。

---

## 1. データフロー全体

```
クライアント (Claude Code / OpenAI 互換クライアント)
   │  POST /v1/messages または /v1/chat/completions
   ▼
server/app.ts  createProxyServer のハンドラ
   │
   ├─ /health                        → 即返す
   ├─ /control/* , /metrics          → server/control.ts
   ├─ /analyze                       → server/analyze.ts（検出のみ）
   ├─ フィルタ対象パス               → server/proxy.ts → api/ のアダプタ
   └─ それ以外                       → server/proxy.ts（無加工で上流へ）
```

「フィルタ対象パス」は各 API アダプタの `paths` が定義し、`api/index.ts` の `resolveApiAdapter(path)` が対応するアダプタを選ぶ。`server/provider.ts` も同じ定義を参照して上流を決める。
現状は `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions` の3つだけ。

`/v1/responses` の専用実装はまだ無い。`api/responses/README.md` はその境界を示すもので、このパスは従来どおり無加工で透過される。

### フィルタ対象リクエストの処理（`server/proxy.ts`）

```
1. readBody          リクエスト本文を読む（サイズ上限つき, server/requestBody.ts）
2. JSON.parse
3. sessionFilters.acquire(req)     → この会話用の PIIFilter を取得
4. API アダプタから PIIFilter を呼ぶ → ★マスク
       └ BlockedByPolicyError が飛んだら 446 を返して終了
5. 上流へ HTTPS リクエスト
6. レスポンスを2通りに分岐
       ├ SSE (stream:true)  → API ごとの StreamRestorer でチャンクごとに復元
       └ 非ストリーム       → api/shared/responseRestorer.ts で復元
7. クライアントへ返す
```

覚えておくと楽なポイント: **マスクは行きだけ、復元は帰りだけ**。この2つは別のコードパスで、共有しているのは `MappingTable` 1個だけ。

---

## 2. ファイル地図

```
src/
├── server.ts              起動用エントリーポイント
├── cli.ts                 CLI
├── server/                HTTP 受付・転送・実行時制御
├── api/
│   ├── index.ts           パスからアダプタを選ぶレジストリ
│   ├── types.ts           ApiAdapter インターフェース
│   ├── messages/          Anthropic Messages API
│   ├── completions/       OpenAI Chat Completions API
│   ├── responses/         OpenAI Responses API の未実装範囲を明記
│   └── shared/            API 間で共有する非ストリーム復元
└── core/                  PII 検出・マスク・復元・設定
```

依存の向きは `server/ → api/ → core/`。サーバから設定や状態などのコア機能を直接参照する箇所もあるが、`core/` は `server/` や `api/` を参照しない。共有のリクエスト本文走査とストリーム復元用コンテキストは `PIIFilter` が提供し、SSE のプロトコル処理は各 API アダプタが担当する。

`server/app.ts` の `createProxyServer` はサーバを組み立てるだけで、待受開始やシグナル登録を行わない。`server/runtime.ts` がそれらを担当し、`server.ts` はポートを解決して起動する薄い入口になっている。テストでは `createProxyServer` を使い、ローカルのモック上流と接続できる。

### 本流（読むべき）

| ファイル | 役割 |
|---|---|
| `server.ts` / `server/runtime.ts` | ポートの解決、待受開始、シグナルハンドラ |
| `server/app.ts` / `server/proxy.ts` | HTTP ルーティング、上流へのプロキシ |
| `api/index.ts` / `api/types.ts` | API アダプタの選択と共通インターフェース |
| `api/messages/index.ts` / `api/completions/index.ts` | API ごとのリクエスト処理とレスポンス復元の接続 |
| `core/piiFilter.ts` | `PIIFilter` クラス。検出段の呼び出し順、マスク、共通の本文走査と復元コンテキスト |
| `core/regexFilter.ts` | 正規表現パターン定義、辞書検出、重なり解決、置換適用 |
| `core/mappingTable.ts` | 元値 ⇄ プレースホルダ の双方向マップ、A/B/C…の採番 |
| `api/messages/streamRestorer.ts` | Anthropic SSE の復元 |
| `api/completions/streamRestorer.ts` | OpenAI Chat Completions SSE の復元 |
| `core/textDeltaRestorer.ts` | 上2つが共有する「分割されたプレースホルダ」のバッファリング |

### 検出段（プラグイン的な位置づけ）

| ファイル | 役割 |
|---|---|
| `core/heuristicNer.ts` / `core/heuristicNerData.ts` | 姓辞書・敬称・法人格・学校名サフィックスによる NAME/ORG/SCHOOL 検出 |
| `core/ollamaFilter.ts` | ローカル LLM への問い合わせ（既定 off） |
| `core/pluginLoader.ts` | 外部 JS モジュールの `detect(text)` を呼ぶ |

### FPE（ステートレス可逆マスク）

| ファイル | 役割 |
|---|---|
| `core/fpe.ts` | FF3-1 の生の実装。NIST SP 800-38G Rev.1 準拠 |
| `core/fpeCodec.ts` | カテゴリごとの桁数定義、MAC 付与、復号ゲート、本文スキャン |
| `core/keys.ts` | マスター鍵の生成・保存（`~/.claude/cloakroom-key`, 0600）と HKDF 派生 |

### 周辺

| ファイル | 役割 |
|---|---|
| `core/config.ts` | `~/.claude/pii-filter.json` の読み込みと正規化。プロセス内キャッシュあり |
| `cli.ts` | `init` / `install` / `start` / `status` / `test` |
| `core/types.ts` | 24種の組み込みカテゴリ定義と日本語ラベル |
| `server/sessionFilterStore.ts` | セッションと `PIIFilter` の対応づけ |
| `core/vault.ts` | マッピングのディスク保存（`vaultEnabled` 時のみ） |
| `server/control.ts` / `server/analyze.ts` | 実行時制御・統計の HTTP API / 検出のみの HTTP API |
| `core/controlState.ts` / `core/controlCategory.ts` | passthrough とカテゴリ個別 on/off のプロセス内状態 |
| `core/stats.ts` | `/metrics` 用のカウンタ |
| `core/auditLog.ts` | `warn` アクションと `block` 時のログ出力 |
| `server/requestBody.ts` | 本文読み取りとサイズ上限 |
| `api/shared/responseRestorer.ts` | 非ストリームレスポンスの復元入口 |
| `server/httpUtils.ts` / `server/provider.ts` / `core/fakeData.ts` | ヘッダ読み取り / 上流振り分け / fake モードのダミー値 |

---

## 3. 検出パイプライン（`core/piiFilter.ts` の `filterText`）

段は5つ。**それぞれが独立に「検出 → 置換」を完了させてから次に進む**。

```
1. 辞書完全一致       detectDictionaryPII  → applyReplacements
2. 正規表現           detectRegexPII       → applyReplacements
3. ヒューリスティックNER detectHeuristicPII  → applyReplacements
4. プラグイン         detectPluginPII      → applyReplacements
5. Ollama             detectOllamaPII      → applyReplacements
```

### ここが重要

各段は**前の段が置換した後の本文**を見る。つまり `[メールアドレスA]` に置き換わった箇所は、後続の段からは元の値が見えない。

結果として:

- **段をまたぐ重なりは「先勝ち」**（先の段が既に消しているので後の段は検出できない）
- **同じ段の中の重なりは `selectNonOverlappingMatches` が解決**する

`selectNonOverlappingMatches`（`core/regexFilter.ts`）の優先順位:

1. 開始位置が早い方
2. 同着なら confidence が高い方
3. それも同着なら長い方

### `applyReplacements` の仕掛け（`core/regexFilter.ts`）

置換は**後ろから前へ**行う。`selectNonOverlappingMatches` が最後に `start` の降順でソートして返すのはこのため。前から置換すると、置換のたびに後続のマッチの `start` / `end` がずれて壊れる。

初見だと「なぜ降順ソート?」で止まる箇所なので、覚えておくといい。

---

## 4. プレースホルダの発番と復元

### 発番（`core/mappingTable.ts` の `register`）

- 同じ元値には**同じプレースホルダ**を再利用する（`originalToPlaceholder` を先に引く）
- 連番は `toAlphabeticSequence` で A → Z → AA（スプレッドシートの列と同じ）
- **カウンタのキーはカテゴリ名ではなく表示ラベル**。カスタムカテゴリのラベルが組み込みと衝突しても、別々のプレースホルダになるようにするため

### 復元（`core/mappingTable.ts` の `replaceAllPlaceholders`）

2パスある。

1. **完全一致パス**: 発行済みプレースホルダを全部 `|` で繋いだ正規表現で1回走査。**長い順にソート**してから繋ぐので、`[人名AA]` が `[人名A]` に食われない
2. **正規化パス**: モデルが `［人名A］`（全角）や `「人名A」` に変形して返してくる場合に備え、括弧内の空白を除去して正規化した上で照合する

---

## 5. ストリーム復元（`api/*/streamRestorer.ts` + `core/textDeltaRestorer.ts`）

SSE は任意の位置でチャンクが切れる。`[メールアド` / `レスA]` に分かれて届くことが普通にある。

### 2段のバッファリング

```
チャンク到着
   ↓
StreamRestorer.sseBuffer     イベント境界（\n\n）が来るまで溜める
   ↓  完成したイベント1個
processEvent → JSON.parse
   ↓  delta.text の文字列
TextDeltaRestorer.pending    閉じ括弧が来るまで溜める
   ↓
復元済みテキスト
```

### `TextDeltaRestorer.process` のロジック

1. 開き括弧（`[` `［` `「`）を探す。無ければ全部出力して終わり
2. 開き括弧の手前までは確定なので出力
3. 対応する閉じ括弧を探す
   - **見つかった** → 括弧ごと `mappingTable.resolve()` に渡す。解決できなければそのまま出す
   - **見つからない** → 溜める。ただし `getMaxPendingLength()` を超えたら1文字だけ吐いて先へ進む

最後の打ち切りが無いと、コード中の `[` を1個拾っただけで以降のストリームが全部止まる。上限は「発行済みプレースホルダの最長 + FPEトークン30文字」。

### `flush()` の存在理由

ストリームが終わっても `pending` に中途半端な文字列が残っていることがある。捨てると出力が欠ける。`message_stop` 時と `end` 時に吐き出す。

---

## 6. FPE — ステートレス可逆マスク

マッピングテーブルは「サーバがそのセッションを覚えている」ことが前提。FPE はそれを不要にする仕組み。

### 考え方

電話番号 `09012345678` を、**同じ11桁の数字列**に暗号化する。形式が保たれるので、周りのコードから見ても電話番号のまま。復号すれば元に戻る。テーブルは要らない。

トークン = `FPE(元の数字)` + `2桁のMAC`

### 復号の3ゲート（`core/fpeCodec.ts` の `decodeWithFpe`）

数字列を見つけるたびに復号を試すので、誤爆を防ぐ関門が3つある。

1. **MAC 検証** — 自分が発行したトークンか
2. **FPE 復号** — 失敗したら諦める
3. **カテゴリ別検証** — CREDIT_CARD なら Luhn、MY_NUMBER なら検査数字

3つ全部通ったものだけ置換する。

### 対応カテゴリ（`core/fpeCodec.ts`）

| カテゴリ | トークン長 | 検証 |
|---|---|---|
| PHONE | 12 / 13桁 | 10桁 or 11桁 |
| CREDIT_CARD | 18桁 | Luhn |
| MY_NUMBER | 14桁 | マイナンバー検査数字 |

`core/fpe.ts` は仕様書からの実装で、ラウンドごとの処理をコメントで説明している。

補足: FF3-1 のラウンド関数は AES の**逆暗号**を使うと仕様で決まっている。`createDecipheriv` を使っているのはそのため。バグではない。

---

## 7. セッションの寿命（`server/sessionFilterStore.ts`）

`PIIFilter` インスタンス（＝ `MappingTable`）を誰と紐付けるか。

| 条件 | 紐付け先 | 寿命 |
|---|---|---|
| `x-pii-session-id` 等のヘッダあり | そのID | 30分（アクセスごとに延長） |
| ヘッダなし | TCP ソケット | 接続が切れるまで |
| `vaultEnabled: true` | 上に加えてディスク保存 | `vaultTtlMinutes` |

**Claude Code はこのヘッダを送らない**ので、実際にはソケット寿命に依存している。ここが仕様レビュー A-2（→ #92）で指摘されている弱点。

---

## 8. 設定の読み込み（`core/config.ts`）

- パス: `~/.claude/pii-filter.json`
- **プロセス内でキャッシュされる**（`loadedConfig`）。`reloadPIIConfig()` か `SIGHUP` か `POST /control/reload` を叩くまで再読み込みされない
- ファイルが無い・壊れている場合は例外を握りつぶして `DEFAULT_CONFIG` にフォールバックする。**設定ミスが黙って無視される**ので、意図通り効いているかは `/control/status` で確認する
- `CLAUDE_PII_FILTER=0` で全体を無効化できる

---

## 9. 落とし穴・既知の欠陥

読んでいて「おかしいのでは」と思ったら、たいてい既知。

| 箇所 | 内容 | Issue |
|---|---|---|
| `api/messages/streamRestorer.ts` | `text_delta` しか復元しない。ツール引数（`input_json_delta`）が復元されず `Edit` が壊れる | [#89](https://github.com/AliceSaikawa/cloakroom/issues/89) |
| `server/provider.ts` | 既定の上流ホストがハードコード | [#90](https://github.com/AliceSaikawa/cloakroom/issues/90) |
| `server/control.ts` | `/control/*` に認証が無い | [#91](https://github.com/AliceSaikawa/cloakroom/issues/91) |
| `server/sessionFilterStore.ts` | TTL / ソケット寿命への依存 | [#92](https://github.com/AliceSaikawa/cloakroom/issues/92) |
| `server/provider.ts` | フィルタ対象外パスが無加工で透過（embeddings、Responses API 等） | [#94](https://github.com/AliceSaikawa/cloakroom/issues/94) |
| `core/regexFilter.ts` | loopback IP やテストカード番号もマスクしてしまう | [#97](https://github.com/AliceSaikawa/cloakroom/issues/97) |

今回の責務分割で、これらの機能制約を解消したわけではない。

一方、**リクエスト側の `tool_use.input` は既にマスクされている**（`core/piiFilter.ts`）し、**非ストリームレスポンスの復元も効いている**（`restoreRecursive` が全文字列を走査する）。壊れているのは SSE 経路だけ。

`thinking` / `redacted_thinking` は往復とも意図的に触っていない（`core/piiFilter.ts`）。署名が壊れるため。

詳細は [`spec-review-2026-09.md`](spec-review-2026-09.md)。

---

## 10. 動かして確かめる

```bash
npm install && npm run build

# 検出だけ試す（マスクしない）
node dist/cli.js test

# プロキシを起動
node dist/cli.js start

# 別ターミナルから
curl -s localhost:8787/control/status | jq
curl -s -X POST localhost:8787/analyze \
  -H 'content-type: application/json' \
  -d '{"text":"山田太郎です。090-1234-5678 まで連絡ください。"}' | jq
```

`/analyze` はマスクせず検出結果だけ返すので、正規表現やヒューリスティックの挙動を確認するのに一番速い。

---

## 11. 分割後の検証

`node test-server.mjs` はローカルのモック上流を使い、HTTP 受付からマスク・転送・復元までを検証する。API キーや外部 API 接続は不要。

既存の `node test-pii-filter.mjs`、`node test-fpe.mjs`、`node test-benchmark.mjs` はコア機能と API 復元処理の回帰確認に使う。`npm test` で HTTP テストを含めた4つをまとめて実行できる。ビルドと型検査は、それぞれ `npm run build` と `npm run typecheck` で行う。
