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
│  (セッション単位の MappingTable)                │
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
- マッピング(元値⇄プレースホルダ)は**セッション単位**で保持される。`x-pii-session-id` / `anthropic-session-id` / `x-session-id` のいずれかのヘッダがあればそのIDに紐付き(30分TTL)、無ければ同じ接続(TCPソケット)が生きている間だけ保持される。`x-pii-session-reset: 1` でそのセッションのマッピングを破棄できる。

## セットアップ

```bash
# 1. 依存関係とビルド
npm install
npm run build

# 2. 設定ファイルを作成 (~/.claude/pii-filter.json)
node dist/cli.js init

# 3. Claude Code 用の接続先を設定 (~/.claude/.env に書き込み)
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

`cloakroom install --for=claude-code` は `~/.claude/.env` に以下を書き込む(既存の同名キーがあれば上書き):

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

プロキシURLは環境変数 `PII_PROXY_URL` で上書きできる(既定 `http://127.0.0.1:8787`)。この`.env`を実際にClaude Codeの起動シェルへ反映させる(source/export する)のは利用者側の責務であり、`cloakroom` 自身はファイルへの書き込みのみを行う。

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
| `categories` | 組み込み全21カテゴリ (`URL_USER` を除く) | 有効化するPIIカテゴリ。`URL_USER`(URL内Basic認証情報)だけは既定では含まれず、使うには明示的に追加する必要がある |
| `ollamaEndpoint` | `"http://localhost:11434"` | Ollama APIのエンドポイント。既定では `localhost` / `127.*` / `::1` のみ許可される |
| `allowRemoteOllama` | `false` | `true` にするとリモートOllamaエンドポイントを許可する。未マスクの固有名詞が送信され得るため、信頼できるホストに限定する |
| `ollamaModel` | `"gemma3:4b"` | 使用するOllamaモデル |
| `ollamaEnabled` | `false` | Ollamaによる `NAME`/`ORG`/`SCHOOL` 検出を使うか(デフォルト無効のオプション機能) |
| `heuristicNerEnabled` | `true` | 組み込みヒューリスティックNER(姓辞書+文脈ルールによる `NAME`/`ORG`/`SCHOOL` 自動検出)を使うか。ゼロランタイム依存で動作し、`false` にすると無効化できる |
| `customPatterns` | `[]` | 追加の正規表現({`name`, `pattern`, `category?`})。`category` があればそのカテゴリ、なければ `name` をカテゴリ名として使う |
| `plugins` | `[]` | ローカルJavaScriptモジュールの絶対パス。`default`、`plugin`、`plugins` のいずれかで `detect(text)` を持つプラグインをexportする。TypeScriptはNode 22で `NODE_OPTIONS=--experimental-strip-types` を付けるか、`.mjs`へコンパイルして使う |
| `dictionary` | `[]` | 完全一致で検出する既知の値({`text`, `category`})。正規表現・Ollamaより先に評価される |
| `allowlist` | `[]` | ここに含まれる文字列(完全一致)は検出されてもマスクされない |

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
cloakroom status
cloakroom test
```

- `start` — `dist/server.js` を子プロセスとして起動する
- `init [--force]` — `~/.claude/pii-filter.json` を作成。既に存在し `--force` が無ければ何もしない
- `install --for=claude-code` — `~/.claude/.env` にClaude Code向け接続先を書き込む
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
| `POST /control/disable/<CATEGORY>` | 指定カテゴリのみ検出を止める(未知のカテゴリは400) |
| `POST /control/enable/<CATEGORY>` | 指定カテゴリの検出を再開 |

```bash
curl http://127.0.0.1:8787/control/status
curl -X POST http://127.0.0.1:8787/control/passthrough
curl -X POST http://127.0.0.1:8787/control/filter
curl -X POST http://127.0.0.1:8787/control/disable/PHONE
```

サーバープロセスに `SIGUSR1` を送るとpassthroughをトグルできる(`kill -USR1 <pid>`)。

## 対応プロバイダ/API

| プロバイダ | フィルタ対象パス | 上流 |
|---|---|---|
| Anthropic | `POST /v1/messages` | `https://api.anthropic.com` |
| OpenAI互換 | `POST /v1/chat/completions` | `https://api.openai.com` |

上記2パス以外へのリクエストは無加工のまま透過プロキシされる(デフォルトはAnthropic向け、`x-provider: openai` ヘッダを付けるとOpenAI向けに転送される)。ストリーミング応答(SSE)はAnthropicの `content_block_delta` 形式・OpenAIの `choices[].delta` 形式の両方に対応し、プレースホルダがチャンク境界で分割されても正しく復元されるようバッファリングする。

## 検出対象のPII種別(正規表現)

`EMAIL`, `PHONE`(日本/国際形式), `ADDRESS`(日本の住所), `URL_USER`(URL内の認証情報), `API_KEY`(`sk-`, `ghp_`, `gho_`, `github_pat_`, `AKIA`, `xox[bpras]-`, `sk-ant-` 等), `CREDIT_CARD`(Luhn検証あり), `MY_NUMBER`(マイナンバー形式), `NAME`(Gitの `Author:`/`Committer:` トレーラーのみ), `SSN`, `IP_ADDRESS`(IPv4/IPv6), `POSTAL_CODE`(郵便番号)。`NAME` / `ORG` / `SCHOOL` の一般的な検出はヒューリスティックNER段(既定有効)が担当し、Ollama LLM(オプション)はその精度を補強する。

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
- 明示的なセッションIDヘッダを送らないクライアントでは、マッピングはTCP接続が維持されている間のみ有効。接続が切れると、以前発行したプレースホルダは復元できなくなる
- `/v1/messages` と `/v1/chat/completions` 以外のパスはPIIフィルタなしで透過プロキシされる
- ソースファイル内のPIIがマスクされることで、コード生成の精度に影響が出る場合がある
- プラグインはローカルモジュールを実行するため、信頼できるファイルだけを `plugins` に設定する。マルチモーダル対応の設計は [docs/multimodal-pii.md](docs/multimodal-pii.md) を参照
