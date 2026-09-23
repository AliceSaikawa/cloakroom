# Cloakroom

**言語**: **日本語** | [English](README_EN.md)

PIIを入口で預かり、番号札を渡し、出口で返すプロキシ。

Claude Code(または任意の Anthropic API / OpenAI 互換クライアント)と上流APIの間に立つローカルHTTPプロキシ。リクエスト本文から個人情報(PII)を検出してプレースホルダに置き換え、レスポンスを表示する直前に元の値へ復元する。

## 仕組み

```
Claude Code / APIクライアント
        │  ANTHROPIC_BASE_URL / OPENAI_BASE_URL → http://127.0.0.1:8787
        ▼
┌─────────────────────────────────────────────────┐
│  Cloakroomプロキシ (127.0.0.1:8787)             │
│                                                 │
│  1. 辞書完全一致 (config.dictionary)            │
│  2. 正規表現 (組み込み + customPatterns)        │
│  3. ヒューリスティックNER (姓辞書+文脈)         │
│  4. Ollama LLM (NAME/ORG/SCHOOL、オプション)    │
│       ↓                                         │
│  プレースホルダ登録 → [メールアドレスA] 等      │
│  (リクエストごとに MappingTable を再構築)       │
└─────────────────────────────────────────────────┘
        │ マスク済みリクエスト
        ▼
  Anthropic API        (POST /v1/messages)
  OpenAI互換API        (POST /v1/chat/completions)
  それ以外のパス        (無加工で透過プロキシ)
        │ レスポンス (JSON または SSE)
        ▼
┌─────────────────────────────────────────────────┐
│  プレースホルダ復元                             │
│  - 非ストリーム: JSONを再帰的に走査して置換     │
│  - ストリーム: text_delta / choices[].delta を  │
│    バッファリングしながら復元 (分割送信に対応)  │
└─────────────────────────────────────────────────┘
        │ 復元済みレスポンス
        ▼
Claude Code / APIクライアント
```

- 検出は4段階: **辞書(完全一致) → 正規表現 → ヒューリスティックNER → Ollama LLM(オプション)**。ヒューリスティックNERは組み込みの姓辞書・法人格・学校名サフィックスと文脈ルールだけで動く、ゼロランタイム依存の段(`heuristicNerEnabled`、既定 `true`)で、`NAME` / `ORG` / `SCHOOL` のいずれかが有効カテゴリに含まれる場合のみ動作する。Ollama LLM段は**オプションの精度向上段**で、デフォルトで無効(`ollamaEnabled: false`)。有効化しても `NAME` / `ORG` / `SCHOOL` の3カテゴリのみを担当し、有効カテゴリにこれらが含まれない場合は呼び出されない。
- ヒューリスティックNER・Ollamaによる検出は **システムプロンプトには適用されない**(system フィールドは辞書・正規表現のみでフィルタされる)。ユーザー/アシスタントのメッセージ本文とツール結果のみが対象。
- プレースホルダは日本語ラベル+アルファベット連番形式(例: `[メールアドレスA]`, `[人名B]`)。連番は `A` から `Z`、続いて `AA` の順で進む。同じ元値は同じプレースホルダに再利用される。`allowlist` に含まれる値はマスクされない。
- マッピング(元値⇄プレースホルダ)は既定で**リクエストごとに再構築**する。会話履歴全体が送られるため、履歴を同じ順に走査すれば同じ値に同じプレースホルダが付き、接続切断やセッションTTLに依存しない。Ollamaの検出結果はブロック内容のHMACをキーにローカルキャッシュし、結果の揺らぎを抑える。旧来のセッションID/リセットヘッダは既定では使わず、`statefulSessionMappings: true` の場合のみ有効になる。
- `thinking` / `redacted_thinking` ブロックは署名を壊さないよう、リクエスト側でも再検出・再マスクせず、レスポンス側でも復元しない。

## セットアップ

```bash
# 1. 依存関係とビルド
npm install
npm run build

# 2. 設定ファイルを作成 (~/.claude/pii-filter.json)
node dist/cli.js init

# 3. Claude Code の settings.json に接続先を設定
node dist/cli.js install --for=claude-code

# 4. プロキシを起動
node dist/cli.js start
```

`npm run build` は esbuild で `src/server.ts` → `dist/server.js`、`src/cli.ts` → `dist/cli.js`(shebang付き)にバンドルする。`package.json` の `bin` は `cloakroom: dist/cli.js` なので、`npm link` 等でグローバル導入すれば `cloakroom` コマンドとしても使える。

人名・組織名・学校名の自動検出はビルトインのヒューリスティックNER(既定有効、`heuristicNerEnabled: true`)がゼロランタイム依存でカバーする。Ollamaによる検出はその**精度をさらに底上げするオプション機能**で、デフォルトは無効。設定ファイルで `ollamaEnabled: true` にすると有効化される。有効にする場合はOllama本体と対象モデル(`gemma3:4b`)が必要:

```bash
brew install ollama
brew services start ollama
ollama pull gemma3:4b
```

Ollamaが応答しない/タイムアウトする場合、その回のOllama検出は静かにスキップされる(辞書・正規表現の結果はそのまま反映される)。

### Claude Code から使う

`cloakroom install --for=claude-code` は `~/.claude/settings.json` の `env` に以下を書き込みます。既存の設定は保持し、元の環境変数値は `~/.claude/cloakroom-settings-backup.json` に保存します(ファイル権限 `0600`)。

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

プロキシURLは環境変数 `PII_PROXY_URL` で上書きできます(既定 `http://127.0.0.1:8787`)。`cloakroom uninstall --for=claude-code` でインストール前の値へ戻せます。`cloakroom doctor` は設定値とプロキシの稼働を確認します。

Claude CodeのOAuth認証で使う `Authorization` や `anthropic-beta` などのリクエストヘッダは、Host等のプロキシ制御用ヘッダを除き上流へ転送されます。

無効化(フィルタを素通しにする): `CLAUDE_PII_FILTER=0 node dist/server.js`

### Hermes Agent から使う

`cloakroom install --for=hermes-agent` は `~/.hermes/.env` に `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` を書き込む。Hermes Agent側では、Chat Completions形式を使うカスタムプロバイダを設定する:

```yaml
# ~/.hermes/config.yaml
providers:
  cloakroom:
    api: http://127.0.0.1:8787/v1
    key_env: OPENAI_API_KEY
model: cloakroom:利用するモデル名
```

この経路では `/v1/chat/completions` がフィルタ対象になる。Hermes Agentのモデルプロバイダ設定とAPIキーは従来どおり利用者が管理する。

## 設定リファレンス

設定ファイル: `~/.claude/pii-filter.json`(`cloakroom init` で生成、`--force` で上書き)。存在しない/壊れている場合は全項目デフォルト値で動作する。

| 項目 | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | フィルタ全体の有効/無効。`false` ならマスク・復元とも行わない |
| `maxRequestBodyBytes` | `67108864` (64 MiB) | リクエスト本文の最大サイズ。超過時は上流へ転送せず `413 Payload Too Large` を返す |
| `mode` | `"pseudonymize"` | `"pseudonymize"` はプレースホルダへ置換、`"anonymize"` は復元不能なプレースホルダへ置換、`"fake"` は復元可能なダミー値へ置換 |
| `categories` | 27種中23種 | 有効化するPIIカテゴリ。既定で無効なのは `URL_USER`, `USERNAME`, `CREDENTIAL_PAIR`, `PASSWORD`。必要に応じて明示的に追加する |
| `ollamaEndpoint` | `"http://localhost:11434"` | Ollama APIのエンドポイント。既定では `localhost` / `127.*` / `::1` のみ許可される |
| `allowRemoteOllama` | `false` | `true` にするとリモートOllamaエンドポイントを許可する。未マスクの固有名詞が送信され得るため、信頼できるホストに限定する |
| `ollamaModel` | `"gemma3:4b"` | 使用するOllamaモデル |
| `ollamaEnabled` | `false` | Ollamaによる `NAME`/`ORG`/`SCHOOL` 検出を使うか(デフォルト無効のオプション機能) |
| `heuristicNerEnabled` | `true` | 組み込みヒューリスティックNER(姓辞書+文脈ルールによる `NAME`/`ORG`/`SCHOOL` 自動検出)を使うか。ゼロランタイム依存で動作し、`false` にすると無効化できる |
| `customPatterns` | `[]` | 追加の正規表現({`name`, `pattern`, `category?`, `flags?`, `captureGroup?`})。`flags` は `i`/`s`/`u`、`captureGroup` は置換するキャプチャグループを指定する |
| `plugins` | `[]` | ローカルJavaScriptモジュールの絶対パス。`default`、`plugin`、`plugins` のいずれかで `detect(text)` を持つプラグインをexportする。TypeScriptはNode 22で `NODE_OPTIONS=--experimental-strip-types` を付けるか、`.mjs`へコンパイルして使う |
| `dictionary` | `[]` | 完全一致で検出する既知の値({`text`, `category`})。正規表現・Ollamaより先に評価される |
| `allowlist` | `[]` | ここに含まれる文字列(完全一致)は検出されてもマスクされない |
| `categoryActions` | `{}` | カテゴリごとの処理方針。`"mask"`(既定: プレースホルダ置換)、`"block"`(リクエスト拒否、`446 Request Rejected` を返す)、`"warn"`(マスクせず audit log のみ記録)の3値を設定できる。例: `{"CREDIT_CARD": "block", "NAME": "warn"}` |
| `upstreams` | `{}` | プロバイダ別の上流URL。例: `{"openai":"http://127.0.0.1:8000/v1", "anthropic":"https://gateway.example.com"}`。HTTPS、またはloopback宛HTTPのみ許可 |
| `allowUnfilteredBodyRequests` | `false` | `true` の場合に限り `/v1/embeddings`、`/v1/files`、`/v1/messages/batches` の未対応本文を未マスクで転送する。既定では403で拒否 |
| `statefulSessionMappings` | `false` | 互換目的で旧来のセッション/ソケット単位マッピングを使う。既定のリクエスト単位再構築を無効化する設定 |

環境変数:

| 変数 | 説明 |
|---|---|
| `CLAUDE_PII_FILTER=0` | 設定ファイルを読まず、フィルタを無効化した状態で起動する |
| `PII_PROXY_PORT` | プロキシサーバーのリッスンポート(既定 `8787`) |
| `PII_PROXY_URL` | `cloakroom status` / `cloakroom install` が参照するプロキシURL(既定 `http://127.0.0.1:8787`) |

## CLI (`cloakroom` / `node dist/cli.js`)

```
cloakroom start
cloakroom init [--force]
cloakroom install --for=claude-code|hermes-agent
cloakroom uninstall --for=claude-code
cloakroom status
cloakroom doctor
cloakroom test
```

- `start` — `dist/server.js` を子プロセスとして起動する
- `init [--force]` — `~/.claude/pii-filter.json` を作成。既に存在し `--force` が無ければ何もしない
- `install --for=claude-code` — `~/.claude/settings.json` の `env` に接続先をマージし、元の値をバックアップする
- `uninstall --for=claude-code` — Cloakroomが設定した値だけを元に戻す。インストール後に手動変更された値は保持する
- `doctor` — Claude Codeの接続先設定と `/health` の応答を確認する
- `install --for=hermes-agent` — `~/.hermes/.env` にHermes Agent向けOpenAI互換接続先を書き込む
- `status` — `/health` と `/control/status` を叩いて結果をJSONで表示。プロキシに到達できなければエラー終了(終了コード1)
- `test` — Ollamaを使わない設定でサンプルテキストをフィルタし、結果を表示する動作確認コマンド

## 実行時制御

サーバー起動中、HTTPエンドポイントで挙動を変更できる(状態はプロセス全体で共有され、再起動でリセットされる):

| エンドポイント | 説明 |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /control/status` | passthrough状態、無効化中カテゴリ、`filterEnabled`、`activeCategories` を返す |
| `POST /control/passthrough` | 全体を素通しモードにする(マスク・復元とも停止) |
| `POST /control/filter` | passthrough解除 + 個別無効化を全リセットしてフィルタ再開 |
| `POST /control/reload` | 設定とプラグインを再読み込みする。既存セッションのプレースホルダ対応は維持する |
| `POST /control/disable/<CATEGORY>` | 指定カテゴリのみ検出を止める(未知のカテゴリは400) |
| `POST /control/enable/<CATEGORY>` | 指定カテゴリの検出を再開 |

```bash
curl http://127.0.0.1:8787/control/status
curl -X POST -H 'X-Cloakroom-Control: 1' http://127.0.0.1:8787/control/passthrough
curl -X POST -H 'X-Cloakroom-Control: 1' http://127.0.0.1:8787/control/filter
curl -X POST -H 'X-Cloakroom-Control: 1' http://127.0.0.1:8787/control/disable/PHONE
```

`/control/*` はloopbackの `Host` のみ受け付け、POSTには `X-Cloakroom-Control: 1` を要求します。カスタムヘッダによりブラウザの単純リクエストから状態を変更できないようにしています。

サーバープロセスに `SIGUSR1` を送るとpassthroughをトグルできる(`kill -USR1 <pid>`)。

## 対応プロバイダ/API

| プロバイダ | フィルタ対象パス | 上流 |
|---|---|---|
| Anthropic | `POST /v1/messages`, `POST /v1/messages/count_tokens` | `https://api.anthropic.com` |
| OpenAI互換 | `POST /v1/chat/completions`, `POST /v1/responses` | `https://api.openai.com` |

OpenAI Responses APIでは `input` と `instructions` をフィルタします。ストリームではテキストに加え、Anthropicの `input_json_delta.partial_json`、OpenAI Chat Completionsの `tool_calls[].function.arguments`、Responses APIの `response.function_call_arguments.delta` も復元します。ツール引数はJSON全体を受信してから出力するため、その部分はツール呼び出し完了まで遅延します。

`/v1/embeddings`、`/v1/files`、`/v1/messages/batches` のPOST/PUT/PATCH本文はマスク未対応のため、既定で403にして上流へ送りません。明示的に許可する場合は `allowUnfilteredBodyRequests: true` を設定してください。それ以外の未対応パスはフィルタなしで透過します。

`upstreams` でプロバイダごとの上流URLを変更できます。OpenAI互換ローカルサーバーでは `http://127.0.0.1:8000/v1` のようなloopback HTTPも使用できます。上流から返るHTTPステータスとエラー/レート制限ヘッダ(例: `Retry-After`)は透過します。

## 検出対象のPII種別(正規表現)

組み込みカテゴリは27種です。正規表現: `EMAIL`, `PHONE`, `ADDRESS`, `URL_USER`, `API_KEY`, `CREDIT_CARD`, `MY_NUMBER`, `NAME`(Gitの `Author:`/`Committer:` は既定 `warn`), `SSN`, `IP_ADDRESS`, `POSTAL_CODE`, `IBAN`, `BANK_ACCOUNT`, `DRIVER_LICENSE`, `PASSPORT`, `CRYPTO_WALLET`, `DATE_TIME`, `MEDICAL_RECORD`, `HEALTH_INSURANCE`, `USERNAME`, `CREDENTIAL_PAIR`, `PASSWORD`, `HOME_PATH`, `MAC_ADDRESS`, `DEVICE_ID`。ヒューリスティックNER: `NAME`, `ORG`, `SCHOOL`。`dictionary` は全カテゴリに利用できます。既定で有効なのは `URL_USER`, `USERNAME`, `CREDENTIAL_PAIR`, `PASSWORD` を除く23種です。`PHONE` は電話関連の文脈、`POSTAL_CODE` は `〒` / 郵便番号ラベルを必要とします。`IP_ADDRESS` はloopback/private/reserved、`CREDIT_CARD` は既知のテスト番号を除外します。検出前に文字列をUnicode NFKC正規化しますが、置換範囲は元の文字列に対応付けます。

同じ検出段の重複は開始位置、信頼度、長さの順で優先して解決し、検出段どうしは先に置換した値を後段が再検出しません。復元は長いプレースホルダから照合するため、`[人名A]` と `[人名AA]` が混同されません。ストリーム復元は最長プレースホルダ長 + 30文字(最低32文字)までを保留し、分割されたプレースホルダを扱います。

Ollamaキャッシュは `~/.claude/cloakroom-ollama-cache.json` に保存されます。内容はローカルの鍵を使ったHMACで識別し、ファイルには元テキストを保存せず、検出位置・カテゴリ・信頼度だけを保存します。キャッシュ上限は2,000ブロック、保存期間は30日です。

`fake` モードは、メールアドレスを `person1@example.com` のような安全なダミー値に置き換え、同一リクエスト内では元の値へ復元できる。モデルがプレースホルダを全角角括弧・日本語のかぎ括弧・空白入りで返しても、発行済みの値だけを復元する。`thinking` と `redacted_thinking` ブロックは署名を壊したりPIIを再挿入したりしないよう、リクエスト側でもレスポンス側でも変更しない。

コードフェンス内、またはファイル名・言語構文・記号密度からコードらしいと判定した文脈では、ヒューリスティックNERの信頼度閾値を `0.9` に上げ、低信頼度の人名候補などを除外します。辞書・正規表現による検出はこの調整の対象外です。

## ヒューリスティックNER(組み込み、Ollama不要)

`heuristicNerEnabled: true`(既定)のとき、正規表現段の後・プラグイン段の前に動作する。ゼロランタイム依存(Node組み込み機能のみ)の静的な姓辞書・法人格・学校名サフィックスと文脈ルールで、`NAME` / `ORG` / `SCHOOL` のいずれかが有効カテゴリに含まれる場合のみ動作する。

- `NAME`: 日本の常用姓辞書(約400語)+敬称(さん/様/部長 等)の組み合わせ、姓+短い名によるフルネーム、`氏名:`/`担当者:` などのラベル文脈、`Taro Yamada` のようなローマ字姓名を検出する。「皆さん」「お客さん」など人名でない語が敬称の前に来るケースは除外される
- `ORG`: `株式会社`/`NPO法人`等の法人格が固有名の前後に直接続く場合と、`Acme Widgets Inc.` のような英語の社名サフィックスを検出する
- `SCHOOL`: `大学`/`高等学校`/`専門学校`等のサフィックスの前に固有名が続く場合を検出する。「私立高校」「国立大学」のような総称のみの表現は除外される

Ollama無効時でもこの段によって主要な人名・組織名・学校名がある程度自動検出されるが、完全ではなく、辞書外の姓や特殊な組織名/学校名は検出漏れが起こり得る(詳細は下記「制限事項」を参照)。

## テスト

| コマンド | 内容 | 前提 |
|---|---|---|
| `node test-pii-filter.mjs` | フィルタON/OFF、バグ回帰、プロバイダ振り分け、ストリーム復元、実行時制御、ヒューリスティックNERのテスト一式 | なし(esbuildでソースを都度バンドルして検証) |
| `node test-pii-filter.mjs --proxy` | 上記に加え、稼働中のプロキシへ実際にリクエストするシナリオも実行 | プロキシが起動済み、かつ `ANTHROPIC_API_KEY` 設定済み |
| `node test-integrated.mjs` | 正規表現+Ollamaの一連の検出パイプラインの精度検証 | `ollamaEnabled: true` 運用時のみ実行。**Ollamaがローカルで稼働**(`gemma3:4b` pull済み) |
| `node test-hard-cases.mjs` | 人名と一般名詞の区別など、Ollama検出の難しいエッジケース検証 | `ollamaEnabled: true` 運用時のみ実行。**Ollamaがローカルで稼働** |
| `node test-ollama-pii-v2.mjs` | Ollamaへの検出プロンプト自体の精度確認 | `ollamaEnabled: true` 運用時のみ実行。**Ollamaがローカルで稼働** |

## 制限事項

- ヒューリスティックNERは静的な姓辞書・法人格・学校名サフィックスに基づく近似的な検出であり、辞書外の姓、一般的でない組織名・学校名、辞書に無いローマ字表記などは検出漏れが起こり得る。より高い精度が必要な場合は `ollamaEnabled: true` を併用するか、`dictionary` / `customPatterns` に明示的に登録する
- ヒューリスティックNER・Ollama検出はいずれもシステムプロンプトには適用されない(system フィールドは辞書・正規表現のみ)
- Ollamaの4Bモデルによる人名/組織名/学校名検出は完全ではなく、誤検出・検出漏れが起こり得る。検出には最大4秒程度のタイムアウト予算があり、新規コンテンツごとにレイテンシが追加される
- リモートOllamaを使う場合、固有名詞など未マスクのテキストがそのホストへ送信され得る。既定ではloopback以外の `ollamaEndpoint` は拒否され、必要な場合のみ `allowRemoteOllama: true` で明示的に許可する
- passthrough/カテゴリ無効化などの実行時制御状態はプロセス全体で共有され、セッションごとの制御はできない。サーバー再起動でリセットされる
- `/v1/embeddings`、`/v1/files`、`/v1/messages/batches` の本文付きリクエストは未対応のため既定で403。opt-inするとPIIフィルタなしで転送される
- 長時間の推論に備えてプロキシのソケット/リクエストタイムアウトは無効化している。上流リクエストから `Accept-Encoding` を除去して圧縮を要求せず、レスポンスの `Content-Encoding` は変更せず転送する。上流が圧縮を返した場合、そのレスポンスは復元処理をせずそのまま転送する。リクエストの `Content-Length` は再計算し、レスポンスでは削除してHTTP framingに任せる。429等のステータスと `Retry-After` は透過する。`446 Request Rejected` はClaude Code上で生のHTTPエラーとして表示される
- ソースファイル内のPIIがマスクされることで、コード生成の精度に影響が出る場合がある
- プラグインはローカルモジュールを実行するため、信頼できるファイルだけを `plugins` に設定する。マルチモーダル対応の設計は [docs/multimodal-pii.md](docs/multimodal-pii.md) を参照

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
