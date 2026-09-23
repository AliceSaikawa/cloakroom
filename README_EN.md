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
│  (MappingTable rebuilt for each request)            │
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
- The original-value ↔ placeholder mapping is **rebuilt for every request by default**. Since the full conversation is resent, scanning it in the same order gives the same values the same placeholders without depending on a TCP connection or session TTL. Ollama detections are cached locally using an HMAC of each content block to keep results stable. Legacy session/reset headers are ignored by default and used only with `statefulSessionMappings: true`.
- `thinking` and `redacted_thinking` blocks are neither re-detected nor re-masked in requests, and are not restored in responses, preserving their signatures.

## Setup

```bash
# 1. Install dependencies and build
npm install
npm run build

# 2. Create the config file (~/.claude/pii-filter.json)
node dist/cli.js init

# 3. Configure Claude Code in settings.json
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

`cloakroom install --for=claude-code` writes the following into the `env` object in `~/.claude/settings.json`, preserving other settings. Original values are backed up to `~/.claude/cloakroom-settings-backup.json` (file mode `0600`).

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
```

The proxy URL can be overridden with the `PII_PROXY_URL` environment variable (default `http://127.0.0.1:8787`). Run `cloakroom uninstall --for=claude-code` to restore the previous values. `cloakroom doctor` checks these settings and whether the proxy is healthy.

Request headers used for Claude Code OAuth, including `Authorization` and `anthropic-beta`, are forwarded upstream; proxy-control headers such as `Host` are handled separately.

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
| `maxRequestBodyBytes` | `67108864` (64 MiB) | Maximum request-body size. Requests above the limit receive `413 Payload Too Large` and are not sent upstream |
| `mode` | `"pseudonymize"` | `"pseudonymize"` uses placeholders, `"anonymize"` uses irreversible placeholders, and `"fake"` uses reversible dummy values |
| `categories` | 23 of 27 built-in categories | Enabled PII categories. `URL_USER`, `USERNAME`, `CREDENTIAL_PAIR`, and `PASSWORD` are disabled by default and can be added explicitly |
| `ollamaEndpoint` | `"http://localhost:11434"` | Ollama API endpoint. By default, only `localhost`, `127.*`, and `::1` are allowed |
| `allowRemoteOllama` | `false` | Allows remote Ollama endpoints when set to `true`. Use only with trusted hosts because unmasked proper nouns may be sent there |
| `ollamaModel` | `"gemma3:4b"` | Ollama model to use |
| `ollamaEnabled` | `false` | Whether Ollama-backed `NAME`/`ORG`/`SCHOOL` detection runs (optional feature, disabled by default) |
| `heuristicNerEnabled` | `true` | Whether the built-in heuristic NER (surname dictionary + contextual rules for `NAME`/`ORG`/`SCHOOL`) runs. Zero runtime dependencies; set to `false` to disable it |
| `customPatterns` | `[]` | Extra regex patterns ({`name`, `pattern`, `category?`, `flags?`, `captureGroup?`}). `flags` supports `i`/`s`/`u`; `captureGroup` selects the capture group to replace |
| `plugins` | `[]` | Absolute paths to local JavaScript modules. Export a plugin with `detect(text)` as `default`, `plugin`, or in `plugins`. For TypeScript on Node 22, use `NODE_OPTIONS=--experimental-strip-types` or compile it to `.mjs` |
| `dictionary` | `[]` | Known exact-match values ({`text`, `category`}). Evaluated before regex and Ollama |
| `allowlist` | `[]` | Exact-match strings that are never masked, even if detected |
| `categoryActions` | `{}` | Per-category action policy. Accepted values are `"mask"` (default: replace with placeholder), `"block"` (reject the request with `446 Request Rejected`), and `"warn"` (skip masking, write to audit log only). Example: `{"CREDIT_CARD": "block", "NAME": "warn"}` |
| `upstreams` | `{}` | Per-provider upstream URLs. Example: `{"openai":"http://127.0.0.1:8000/v1", "anthropic":"https://gateway.example.com"}`. HTTPS and loopback HTTP are allowed |
| `allowUnfilteredBodyRequests` | `false` | Set to `true` to pass unsupported bodies for `/v1/embeddings`, `/v1/files`, and `/v1/messages/batches` without masking. These requests are rejected with 403 by default |
| `statefulSessionMappings` | `false` | Enables legacy per-session/socket mappings for compatibility instead of rebuilding mappings for each request |

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
cloakroom uninstall --for=claude-code
cloakroom status
cloakroom doctor
cloakroom test
```

- `start` — spawns `dist/server.js` as a child process
- `init [--force]` — creates `~/.claude/pii-filter.json`. Does nothing if it already exists and `--force` is not passed
- `install --for=claude-code` — merges proxy settings into `env` in `~/.claude/settings.json` and backs up prior values
- `uninstall --for=claude-code` — restores only values still matching those installed by Cloakroom; manually changed values are preserved
- `doctor` — checks Claude Code's proxy settings and the `/health` endpoint
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
| `POST /control/reload` | Reloads configuration and plugins while preserving existing session placeholder mappings |
| `POST /control/disable/<CATEGORY>` | Stops detecting a single category (unknown category returns 400) |
| `POST /control/enable/<CATEGORY>` | Resumes detecting a single category |

```bash
curl http://127.0.0.1:8787/control/status
curl -X POST -H 'X-Cloakroom-Control: 1' http://127.0.0.1:8787/control/passthrough
curl -X POST -H 'X-Cloakroom-Control: 1' http://127.0.0.1:8787/control/filter
curl -X POST -H 'X-Cloakroom-Control: 1' http://127.0.0.1:8787/control/disable/PHONE
```

`/control/*` accepts only loopback `Host` values, and POST requests require `X-Cloakroom-Control: 1`. The custom header prevents browser simple requests from changing proxy state.

Sending `SIGUSR1` to the server process toggles passthrough mode (`kill -USR1 <pid>`).

## Supported providers / APIs

| Provider | Filtered path | Upstream |
|---|---|---|
| Anthropic | `POST /v1/messages`, `POST /v1/messages/count_tokens` | `https://api.anthropic.com` |
| OpenAI-compatible | `POST /v1/chat/completions`, `POST /v1/responses` | `https://api.openai.com` |

For the Responses API, both `input` and `instructions` are filtered. Streaming restoration covers text plus Anthropic `input_json_delta.partial_json`, OpenAI Chat Completions `tool_calls[].function.arguments`, and Responses API `response.function_call_arguments.delta`. Tool arguments are buffered until the complete JSON arguments arrive, which delays that part of the stream until the tool call completes.

Bodies sent to `/v1/embeddings`, `/v1/files`, or `/v1/messages/batches` using POST/PUT/PATCH are unsupported by the filter and receive 403 by default. Set `allowUnfilteredBodyRequests: true` only if you explicitly accept sending these bodies unmasked. Other unsupported routes are passed through without filtering.

Configure provider-specific upstreams with `upstreams`. Loopback HTTP, such as `http://127.0.0.1:8000/v1`, is supported for local OpenAI-compatible servers. Upstream HTTP statuses and error/rate-limit headers (including `Retry-After`) are passed through.

## PII categories detected by regex

There are 27 built-in categories. Regex detection covers `EMAIL`, `PHONE`, `ADDRESS`, `URL_USER`, `API_KEY`, `CREDIT_CARD`, `MY_NUMBER`, `NAME` (Git `Author:`/`Committer:` trailers default to `warn`), `SSN`, `IP_ADDRESS`, `POSTAL_CODE`, `IBAN`, `BANK_ACCOUNT`, `DRIVER_LICENSE`, `PASSPORT`, `CRYPTO_WALLET`, `DATE_TIME`, `MEDICAL_RECORD`, `HEALTH_INSURANCE`, `USERNAME`, `CREDENTIAL_PAIR`, `PASSWORD`, `HOME_PATH`, `MAC_ADDRESS`, and `DEVICE_ID`. Heuristic NER covers `NAME`, `ORG`, and `SCHOOL`; `dictionary` can be used with any category. The 23 enabled by default exclude `URL_USER`, `USERNAME`, `CREDENTIAL_PAIR`, and `PASSWORD`. `PHONE` requires phone-related context, and `POSTAL_CODE` requires `〒` or an explicit postal-code label. Loopback/private/reserved IP addresses and known test card numbers are excluded. Text is normalized with Unicode NFKC before detection, and detected ranges are mapped back to the original text.

Overlapping matches within a detection stage are resolved by start position, confidence, then length; later stages do not see values already replaced by an earlier stage. Restoration checks longer placeholders first, so `[人名A]` and `[人名AA]` cannot collide. Stream restoration buffers up to the longest placeholder plus 30 characters (at least 32) to handle split placeholders.

The Ollama cache is stored at `~/.claude/cloakroom-ollama-cache.json`. It identifies content using an HMAC derived from the local key and stores only match offsets, categories, and confidence, not the source text. It keeps up to 2,000 blocks for 30 days.

`fake` mode replaces values with safe dummy data such as `person1@example.com` and can restore the originals within the same request. If a model returns an issued placeholder with full-width brackets, Japanese quotes, or added whitespace, it is still restored. `thinking` and `redacted_thinking` blocks are not changed on either the request or response path, preserving signed reasoning blocks.

Inside fenced code, or context classified as code-like from file names, language syntax, and symbol density, heuristic NER raises its confidence threshold to `0.9` and drops lower-confidence name candidates. Dictionary and regex detection are not changed by this adjustment.

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
- Bodies sent to `/v1/embeddings`, `/v1/files`, or `/v1/messages/batches` are unsupported and rejected with 403 by default; opting in forwards them without PII filtering
- Proxy socket and request timeouts are disabled for long-running inference. `Accept-Encoding` is removed from upstream requests; any response `Content-Encoding` is forwarded unchanged. If an upstream returns a compressed response anyway, it bypasses restoration and is forwarded as-is. Request `Content-Length` is recalculated, while the response header is removed and HTTP framing is left to Node. Statuses such as 429 and `Retry-After` pass through. `446 Request Rejected` appears as a raw HTTP error in Claude Code
- Masking PII inside source code can affect code-generation accuracy
- Plugins execute local modules, so only configure trusted files in `plugins`. See [docs/multimodal-pii.md](docs/multimodal-pii.md) for the multimodal PII design

## License

MIT License. See [LICENSE](LICENSE) for details.
