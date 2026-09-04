# Cloakroom アーキテクチャ / コードリーディングガイド

`src/` を初めて読む人向けの地図。基準コミット `c113d35`（src 全28ファイル・約4,320行）。

## 0. 読む順番

コメントが少ないので、闇雲に開くと迷子になる。この順で追うと全体像が繋がる。

| 順 | ファイル | 行数 | 何が分かるか |
|---|---|---|---|
| 1 | `server.ts` | 425 | HTTP の入口。全リクエストの分岐 |
| 2 | `piiFilter.ts` | 534 | マスクと復元の司令塔 |
| 3 | `regexFilter.ts` の `applyReplacements` / `selectNonOverlappingMatches` | — | 「検出結果をどう本文に適用するか」 |
| 4 | `mappingTable.ts` | 135 | 番号札の発番と引き換え |
| 5 | `streamRestorer.ts` + `textDeltaRestorer.ts` | 152 | SSE の途中で切れたプレースホルダの扱い |
| 6 | `fpe.ts` / `fpeCodec.ts` | 181 | ステートレス可逆マスク |

残りは周辺（設定・CLI・統計・監査ログ）なので、必要になってから読めばいい。

---

## 1. データフロー全体

```
クライアント (Claude Code)
   │  POST /v1/messages
   ▼
server.ts  createServer のハンドラ (365行目〜)
   │
   ├─ /health                        → 即返す
   ├─ /control/* , /metrics          → handleControlRequest
   ├─ /analyze                       → handleAnalyze（検出のみ、マスクしない）
   ├─ フィルタ対象パス               → handleMessages     ★本流
   └─ それ以外                       → proxyPassThrough（無加工で上流へ）
```

「フィルタ対象パス」は `provider.ts` の `filteredPaths` で決まる。
現状は `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions` の3つだけ。

### handleMessages の中身（`server.ts:261`）

```
1. readBody          リクエスト本文を読む（サイズ上限つき, requestBody.ts）
2. JSON.parse
3. sessionFilters.acquire(req)     → この会話用の PIIFilter を取得
4. filter.filterRequestBody(body)  → ★マスク
       └ BlockedByPolicyError が飛んだら 446 を返して終了
5. 上流へ HTTPS リクエスト
6. レスポンスを2通りに分岐
       ├ SSE (stream:true)  → StreamRestorer でチャンクごとに復元
       └ 非ストリーム       → 全部溜めてから restoreNonStreamingResponse
7. クライアントへ返す
```

覚えておくと楽なポイント: **マスクは行きだけ、復元は帰りだけ**。この2つは別のコードパスで、共有しているのは `MappingTable` 1個だけ。

---

## 2. ファイル地図

### 本流（読むべき）

| ファイル | 役割 |
|---|---|
| `server.ts` | HTTP サーバ、ルーティング、上流へのプロキシ、シグナルハンドラ |
| `piiFilter.ts` | `PIIFilter` クラス。検出段の呼び出し順、マスク、復元の再帰走査 |
| `regexFilter.ts` | 正規表現パターン定義（514行の大半がこれ）、辞書検出、重なり解決、置換適用 |
| `mappingTable.ts` | 元値 ⇄ プレースホルダ の双方向マップ、A/B/C…の採番 |
| `streamRestorer.ts` | Anthropic SSE の復元 |
| `openaiStreamRestorer.ts` | OpenAI SSE の復元（構造はほぼ同じ） |
| `textDeltaRestorer.ts` | 上2つが共有する「分割されたプレースホルダ」のバッファリング |

### 検出段（プラグイン的な位置づけ）

| ファイル | 役割 |
|---|---|
| `heuristicNer.ts` / `heuristicNerData.ts` | 姓辞書・敬称・法人格・学校名サフィックスによる NAME/ORG/SCHOOL 検出 |
| `ollamaFilter.ts` | ローカル LLM への問い合わせ（既定 off） |
| `pluginLoader.ts` | 外部 JS モジュールの `detect(text)` を呼ぶ |

### FPE（ステートレス可逆マスク）

| ファイル | 役割 |
|---|---|
| `fpe.ts` | FF3-1 の生の実装。NIST SP 800-38G Rev.1 準拠 |
| `fpeCodec.ts` | カテゴリごとの桁数定義、MAC 付与、復号ゲート、本文スキャン |
| `keys.ts` | マスター鍵の生成・保存（`~/.claude/cloakroom-key`, 0600）と HKDF 派生 |

### 周辺

| ファイル | 役割 |
|---|---|
| `config.ts` | `~/.claude/pii-filter.json` の読み込みと正規化。プロセス内キャッシュあり |
| `cli.ts` | `init` / `install` / `start` / `status` / `test` |
| `types.ts` | 24種の組み込みカテゴリ定義と日本語ラベル |
| `sessionFilterStore.ts` | セッションと `PIIFilter` の対応づけ |
| `vault.ts` | マッピングのディスク保存（`vaultEnabled` 時のみ） |
| `controlState.ts` / `controlCategory.ts` | passthrough とカテゴリ個別 on/off のプロセス内状態 |
| `stats.ts` | `/metrics` 用のカウンタ |
| `auditLog.ts` | `warn` アクションと `block` 時のログ出力 |
| `requestBody.ts` | 本文読み取りとサイズ上限 |
| `responseRestorer.ts` | 非ストリームレスポンスの復元入口 |
| `httpUtils.ts` / `provider.ts` / `fakeData.ts` | ヘッダ読み取り / 上流振り分け / fake モードのダミー値 |

---

## 3. 検出パイプライン（`piiFilter.ts:465` `filterText`）

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

`selectNonOverlappingMatches`（`regexFilter.ts:50`）の優先順位:

1. 開始位置が早い方
2. 同着なら confidence が高い方
3. それも同着なら長い方

### `applyReplacements` の仕掛け（`regexFilter.ts:554`）

置換は**後ろから前へ**行う。`selectNonOverlappingMatches` が最後に `start` の降順でソートして返すのはこのため。前から置換すると、置換のたびに後続のマッチの `start` / `end` がずれて壊れる。

初見だと「なぜ降順ソート?」で止まる箇所なので、覚えておくといい。

---

## 4. プレースホルダの発番と復元

### 発番（`mappingTable.ts:26` `register`）

- 同じ元値には**同じプレースホルダ**を再利用する（`originalToPlaceholder` を先に引く）
- 連番は `toAlphabeticSequence` で A → Z → AA（スプレッドシートの列と同じ）
- **カウンタのキーはカテゴリ名ではなく表示ラベル**。カスタムカテゴリのラベルが組み込みと衝突しても、別々のプレースホルダになるようにするため

### 復元（`mappingTable.ts:58` `replaceAllPlaceholders`）

2パスある。

1. **完全一致パス**: 発行済みプレースホルダを全部 `|` で繋いだ正規表現で1回走査。**長い順にソート**してから繋ぐので、`[人名AA]` が `[人名A]` に食われない
2. **正規化パス**: モデルが `［人名A］`（全角）や `「人名A」` に変形して返してくる場合に備え、括弧内の空白を除去して正規化した上で照合する

---

## 5. ストリーム復元（`streamRestorer.ts` + `textDeltaRestorer.ts`）

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

### 復号の3ゲート（`fpeCodec.ts:92` `decodeWithFpe`）

数字列を見つけるたびに復号を試すので、誤爆を防ぐ関門が3つある。

1. **MAC 検証** — 自分が発行したトークンか
2. **FPE 復号** — 失敗したら諦める
3. **カテゴリ別検証** — CREDIT_CARD なら Luhn、MY_NUMBER なら検査数字

3つ全部通ったものだけ置換する。

### 対応カテゴリ（`fpeCodec.ts:21`）

| カテゴリ | トークン長 | 検証 |
|---|---|---|
| PHONE | 12 / 13桁 | 10桁 or 11桁 |
| CREDIT_CARD | 18桁 | Luhn |
| MY_NUMBER | 14桁 | マイナンバー検査数字 |

`fpe.ts` は仕様書からの実装なのでコメントが厚い（34%）。ここは読めば分かるように書いてある。

補足: FF3-1 のラウンド関数は AES の**逆暗号**を使うと仕様で決まっている。`createDecipheriv` を使っているのはそのため。バグではない。

---

## 7. セッションの寿命（`sessionFilterStore.ts`）

`PIIFilter` インスタンス（＝ `MappingTable`）を誰と紐付けるか。

| 条件 | 紐付け先 | 寿命 |
|---|---|---|
| `x-pii-session-id` 等のヘッダあり | そのID | 30分（アクセスごとに延長） |
| ヘッダなし | TCP ソケット | 接続が切れるまで |
| `vaultEnabled: true` | 上に加えてディスク保存 | `vaultTtlMinutes` |

**Claude Code はこのヘッダを送らない**ので、実際にはソケット寿命に依存している。ここが仕様レビュー A-2（→ #92）で指摘されている弱点。

---

## 8. 設定の読み込み（`config.ts`）

- パス: `~/.claude/pii-filter.json`
- **プロセス内でキャッシュされる**（`loadedConfig`）。`reloadPIIConfig()` か `SIGHUP` か `POST /control/reload` を叩くまで再読み込みされない
- ファイルが無い・壊れている場合は例外を握りつぶして `DEFAULT_CONFIG` にフォールバックする。**設定ミスが黙って無視される**ので、意図通り効いているかは `/control/status` で確認する
- `CLAUDE_PII_FILTER=0` で全体を無効化できる

---

## 9. 落とし穴・既知の欠陥

読んでいて「おかしいのでは」と思ったら、たいてい既知。

| 箇所 | 内容 | Issue |
|---|---|---|
| `streamRestorer.ts` | `text_delta` しか復元しない。ツール引数（`input_json_delta`）が復元されず `Edit` が壊れる | [#89](https://github.com/AliceSaikawa/cloakroom/issues/89) |
| `provider.ts` | 上流ホストがハードコード | [#90](https://github.com/AliceSaikawa/cloakroom/issues/90) |
| `server.ts:95` | `/control/*` に認証が無い | [#91](https://github.com/AliceSaikawa/cloakroom/issues/91) |
| `sessionFilterStore.ts` | TTL / ソケット寿命への依存 | [#92](https://github.com/AliceSaikawa/cloakroom/issues/92) |
| `provider.ts` | フィルタ対象外パスが無加工で透過（embeddings 等） | [#94](https://github.com/AliceSaikawa/cloakroom/issues/94) |
| `regexFilter.ts` | loopback IP やテストカード番号もマスクしてしまう | [#97](https://github.com/AliceSaikawa/cloakroom/issues/97) |

一方、**リクエスト側の `tool_use.input` は既にマスクされている**（`piiFilter.ts:430`）し、**非ストリームレスポンスの復元も効いている**（`restoreRecursive` が全文字列を走査する）。壊れているのは SSE 経路だけ。

`thinking` / `redacted_thinking` は往復とも意図的に触っていない（`piiFilter.ts:432`, `:520`）。署名が壊れるため。

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
