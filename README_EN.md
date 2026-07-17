# Cloakroom

**Language**: [日本語](README.md) | **English**

Checks your PII at the door, hands the API a ticket, and gives everything back on the way out.

A local HTTP proxy that sits between Claude Code (or any Anthropic API / OpenAI-compatible client) and the upstream API. It detects personally identifiable information (PII) in the request body, replaces it with placeholders, and restores the original values right before the response is displayed.

## How it works

```
Claude Code / API client
        │  ANTHROPIC_BASE_URL / OPENAI_BASE_URL → http://127.0.0.1:8787
        ▼
┌─────────────────────────────────────────────────────┐
│  Cloakroom proxy (127.0.0.1:8787)                   │
│                                                     │
│  1. Dictionary exact match (config.dictionary)      │
│  2. Regex match (built-in + customPatterns)         │
│  3. Heuristic NER (surname dictionary + context)    │
│  4. Ollama LLM match (NAME/ORG/SCHOOL, optional)    │
│       ↓                                             │
│  Placeholder registration → [メールアドレスA]       │
│  (per-session MappingTable)                         │
└─────────────────────────────────────────────────────┘
        │ masked request
        ▼
  Anthropic API        (POST /v1/messages)
  OpenAI-compatible API (POST /v1/chat/completions)
  Any other path        (passed through untouched)
        │ response (JSON or SSE)
        ▼
┌─────────────────────────────────────────────────────┐
│  Placeholder restoration                            │
│  - Non-streaming: recursive walk over the JSON      │
│  - Streaming: buffers text_delta / choices[].delta  │
│    so split placeholders still resolve correctly    │
└─────────────────────────────────────────────────────┘
        │ restored response
        ▼
Claude Code / API client
```

- Detection happens in four stages: **dictionary (exact match) → regex → heuristic NER → Ollama LLM (optional)**. The heuristic NER stage (`heuristicNerEnabled`, defaults to `true`) is a zero-runtime-dependency stage that runs on a built-in surname dictionary, legal-entity suffixes, and school-name suffixes plus contextual rules; it only runs when `NAME` / `ORG` / `SCHOOL` is in the active category list. The Ollama LLM stage is an **optional accuracy-boosting stage**, disabled by default (`ollamaEnabled: false`); when enabled, it only handles the `NAME` / `ORG` / `SCHOOL` categories, and is skipped entirely if none of those are in the active category list.
- Heuristic NER and Ollama detection are **not applied to the system prompt** (the `system` field is only filtered by dictionary and regex). Only user/assistant message content and tool results go through those stages.
- Built-in placeholders use Japanese labels plus alphabetic counters (e.g. `[メールアドレスA]`, `[人名B]`). Counters continue from `A` through `Z`, then `AA`. The same original value always reuses the same placeholder. Values in `allowlist` are never masked.
- The original-value ↔ placeholder mapping is kept **per session**. If a request carries `x-pii-session-id`, `anthropic-session-id`, or `x-session-id`, the mapping is tied to that ID (30-minute TTL); otherwise it lives only as long as the underlying TCP connection stays open. Sending `x-pii-session-reset: 1` discards that session's mapping.

## Setup

```bash
# 1. Install dependencies and build
npm install
npm run build

# 2. Create the config file (~/.claude/pii-filter.json)
node dist/cli.js init

# 3. Configure Claude Code's connection target (writes ~/.claude/.env)
node dist/cli.js install --for=claude-code

# 4. Start the proxy
node dist/cli.js start
```

`npm run build` bundles `src/server.ts` → `dist/server.js` and `src/cli.ts` → `dist/cli.js` (with a shebang) via esbuild. `package.json`'s `bin` maps `cloakroom` to `dist/cli.js`, so linking it globally (e.g. `npm link`) also gives you a `cloakroom` command.

Automatic detection of names, organizations, and schools is covered by the built-in heuristic NER (enabled by default, `heuristicNerEnabled: true`), which runs with zero runtime dependencies. Ollama-backed detection is an **optional feature that further improves accuracy on top of it**, and is disabled by default. Set `ollamaEnabled: true` in the config file to enable it. When enabled, it requires Ollama itself plus the target model (`gemma3:4b`):

```bash
brew install ollama
brew services start ollama
ollama pull gemma3:4b
```

If Ollama is unreachable or times out, that round of Ollama detection is silently skipped (dictionary and regex results are still applied).

### Using it with Claude Code

`cloakroom install --for=claude-code` writes the following into `~/.claude/.env` (overwriting any existing matching keys):

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

The proxy URL can be overridden with the `PII_PROXY_URL` environment variable (default `http://127.0.0.1:8787`). Actually sourcing/exporting this `.env` file into the shell that launches Claude Code is left to the user — `cloakroom` itself only writes the file.

To disable filtering entirely (pass everything through untouched): `CLAUDE_PII_FILTER=0 node dist/server.js`

### Using it with Hermes Agent

`cloakroom install --for=hermes-agent` writes `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` to `~/.hermes/.env`. Configure a Chat Completions custom provider in Hermes Agent:

```yaml
# ~/.hermes/config.yaml
providers:
  cloakroom:
    api: http://127.0.0.1:8787/v1
    key_env: OPENAI_API_KEY
model: cloakroom:your-model-name
```

Requests through this provider use `/v1/chat/completions`, which Cloakroom filters. The user continues to manage their Hermes provider settings and API key.

## Configuration reference

Config file: `~/.claude/pii-filter.json` (created by `cloakroom init`, overwritten with `--force`). If it is missing or malformed, every field falls back to its default.

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off switch. When `false`, neither masking nor restoration runs |
| `categories` | All 21 built-in categories except `URL_USER` | Enabled PII categories. `URL_USER` (Basic-auth-style userinfo in a URL) is not included by default and must be added explicitly |
| `ollamaEndpoint` | `"http://localhost:11434"` | Ollama API endpoint. By default, only `localhost`, `127.*`, and `::1` are allowed |
| `allowRemoteOllama` | `false` | Allows remote Ollama endpoints when set to `true`. Use only with trusted hosts because unmasked proper nouns may be sent there |
| `ollamaModel` | `"gemma3:4b"` | Ollama model to use |
| `ollamaEnabled` | `false` | Whether Ollama-backed `NAME`/`ORG`/`SCHOOL` detection runs (optional feature, disabled by default) |
| `heuristicNerEnabled` | `true` | Whether the built-in heuristic NER (surname dictionary + contextual rules for `NAME`/`ORG`/`SCHOOL`) runs. Zero runtime dependencies; set to `false` to disable it |
| `customPatterns` | `[]` | Extra regex patterns ({`name`, `pattern`, `category?`}). Uses `category` when provided, otherwise uses `name` as the category |
| `plugins` | `[]` | Absolute paths to local JavaScript modules. Export a plugin with `detect(text)` as `default`, `plugin`, or in `plugins`. For TypeScript on Node 22, use `NODE_OPTIONS=--experimental-strip-types` or compile it to `.mjs` |
| `dictionary` | `[]` | Known exact-match values ({`text`, `category`}). Evaluated before regex and Ollama |
| `allowlist` | `[]` | Exact-match strings that are never masked, even if detected |

Environment variables:

| Variable | Description |
|---|---|
| `CLAUDE_PII_FILTER=0` | Skip reading the config file and start with filtering disabled |
| `PII_PROXY_PORT` | Port the proxy server listens on (default `8787`) |
| `PII_PROXY_URL` | Proxy URL that `cloakroom status` / `cloakroom install` target (default `http://127.0.0.1:8787`) |

## CLI (`cloakroom` / `node dist/cli.js`)

```
cloakroom start
cloakroom init [--force]
cloakroom install --for=claude-code|hermes-agent
cloakroom status
cloakroom test
```

- `start` — spawns `dist/server.js` as a child process
- `init [--force]` — creates `~/.claude/pii-filter.json`. Does nothing if it already exists and `--force` is not passed
- `install --for=claude-code` — writes the Claude Code connection settings to `~/.claude/.env`
- `install --for=hermes-agent` — writes the Hermes Agent OpenAI-compatible connection setting to `~/.hermes/.env`
- `status` — hits `/health` and `/control/status` and prints the combined result as JSON; exits with code 1 if the proxy is unreachable
- `test` — runs a sample text through the filter with Ollama disabled, printing the result, as a quick sanity check

## Runtime controls

While the server is running, its behavior can be changed via HTTP endpoints (this state is shared across the whole process and resets on restart):

| Endpoint | Description |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /control/status` | Returns passthrough state, disabled categories, `filterEnabled`, and `activeCategories` |
| `POST /control/passthrough` | Switches to full passthrough mode (both masking and restoration stop) |
| `POST /control/filter` | Clears passthrough mode and all per-category disables, resuming full filtering |
| `POST /control/disable/<CATEGORY>` | Stops detecting a single category (unknown category returns 400) |
| `POST /control/enable/<CATEGORY>` | Resumes detecting a single category |

```bash
curl http://127.0.0.1:8787/control/status
curl -X POST http://127.0.0.1:8787/control/passthrough
curl -X POST http://127.0.0.1:8787/control/filter
curl -X POST http://127.0.0.1:8787/control/disable/PHONE
```

Sending `SIGUSR1` to the server process toggles passthrough mode (`kill -USR1 <pid>`).

## Supported providers / APIs

| Provider | Filtered path | Upstream |
|---|---|---|
| Anthropic | `POST /v1/messages` | `https://api.anthropic.com` |
| OpenAI-compatible | `POST /v1/chat/completions` | `https://api.openai.com` |

Requests to any other path are passed through untouched (defaulting to Anthropic, or to OpenAI if the `x-provider: openai` header is set). Streaming (SSE) responses are supported for both Anthropic's `content_block_delta` format and OpenAI's `choices[].delta` format; text is buffered so placeholders split across chunk boundaries still restore correctly.

## PII categories detected by regex

`EMAIL`, `PHONE` (Japanese and international formats), `ADDRESS` (Japanese addresses), `URL_USER` (credentials embedded in a URL), `API_KEY` (`sk-`, `ghp_`, `gho_`, `github_pat_`, `AKIA`, `xox[bpras]-`, `sk-ant-`, etc.), `CREDIT_CARD` (Luhn-validated), `MY_NUMBER` (Japanese My Number format), `NAME` (only via Git's `Author:`/`Committer:` trailers), `SSN`, `IP_ADDRESS` (IPv4/IPv6), `POSTAL_CODE`. General detection of `NAME` / `ORG` / `SCHOOL` is handled by the heuristic NER stage (enabled by default), with the optional Ollama LLM stage further improving accuracy.

## Heuristic NER (built in, no Ollama required)

When `heuristicNerEnabled: true` (the default), this stage runs after regex and before plugins. It uses zero-runtime-dependency static dictionaries (surnames, legal-entity suffixes, school-name suffixes) plus contextual rules, and only runs when `NAME` / `ORG` / `SCHOOL` is in the active category list.

- `NAME`: detects a common Japanese surname (~400 entries) followed by an honorific (さん/様/部長, etc.), a surname plus a short given name forming a full name, labeled contexts like `氏名:`/`担当者:`, and romaji full names such as `Taro Yamada`. Non-name words that happen to precede an honorific (e.g. 皆さん, お客さん) are excluded
- `ORG`: detects a legal form (`株式会社`, `NPO法人`, etc.) directly attached to a proper noun, either before or after it, as well as English company suffixes like `Acme Widgets Inc.`
- `SCHOOL`: detects a proper noun directly followed by a school suffix (`大学`, `高等学校`, `専門学校`, etc.). Generic phrases with no proper noun, such as 私立高校 or 国立大学, are excluded

Even with Ollama disabled, this stage provides reasonable automatic coverage of common names, organizations, and schools, though it is not exhaustive — surnames outside the dictionary and unusual organization/school names can still be missed (see Limitations below).

## Tests

| Command | What it checks | Requires |
|---|---|---|
| `node test-pii-filter.mjs` | Filter ON/OFF, bug regressions, provider routing, stream restoration, runtime control, heuristic NER | None (bundles source on the fly with esbuild) |
| `node test-pii-filter.mjs --proxy` | Same as above, plus a scenario that hits a running proxy for real | A running proxy and `ANTHROPIC_API_KEY` set |
| `node test-integrated.mjs` | Accuracy of the full regex + Ollama detection pipeline | Only relevant when running with `ollamaEnabled: true`. **Ollama running locally** with `gemma3:4b` pulled |
| `node test-hard-cases.mjs` | Hard edge cases for Ollama detection (e.g. names vs. common nouns) | Only relevant when running with `ollamaEnabled: true`. **Ollama running locally** |
| `node test-ollama-pii-v2.mjs` | Accuracy of the Ollama detection prompt itself | Only relevant when running with `ollamaEnabled: true`. **Ollama running locally** |

## Limitations

- Heuristic NER is an approximate detector based on static surname/legal-entity/school-suffix dictionaries; surnames outside the dictionary, uncommon organization or school names, and unlisted romaji spellings can be missed. For higher accuracy, combine it with `ollamaEnabled: true` or register known values explicitly in `dictionary` / `customPatterns`
- Neither heuristic NER nor Ollama detection applies to the system prompt (the `system` field only goes through dictionary and regex filtering)
- Ollama's 4B model is not perfectly accurate for name/org/school detection; false positives and misses can occur. Detection has a timeout budget of roughly 4 seconds and adds latency per new content block
- When remote Ollama is enabled, unmasked text such as proper nouns may be sent to that host. Non-loopback `ollamaEndpoint` values are rejected by default; set `allowRemoteOllama: true` only when the host is trusted
- Runtime controls (passthrough, per-category disable) are process-wide, not per-session, and reset when the server restarts
- For clients that do not send an explicit session ID header, the mapping only lives as long as the TCP connection stays open; once it drops, previously issued placeholders can no longer be restored
- Paths other than `/v1/messages` and `/v1/chat/completions` are proxied without any PII filtering
- Masking PII inside source code can affect code-generation accuracy
- Plugins execute local modules, so only configure trusted files in `plugins`. See [docs/multimodal-pii.md](docs/multimodal-pii.md) for the multimodal PII design
