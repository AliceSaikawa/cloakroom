# Cloakroom

**Language**: [日本語](README.md) | **English**

Checks your PII at the door, hands the API a ticket, and gives everything back on the way out.

A local HTTP proxy that sits between Claude Code (or any Anthropic API / OpenAI-compatible client) and the upstream API. It detects personally identifiable information (PII) in the request body, replaces it with placeholders, and restores the original values right before the response is displayed.

Cloakroom is an additional defense layer. It does not guarantee complete PII detection or legal compliance. Its `anonymize` mode means that this application does not restore the original values; it does not create legally defined "anonymized information."

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
│  Placeholder registration → <pii:email id="1"/>     │
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
- The default internal placeholder is an XML-style token such as `<pii:email id="1"/>`. It avoids collisions with Markdown links and code brackets and contains a category and counter. Set `placeholderFormat: "legacy"` to keep the old `[メールアドレスA]` style. The same original value reuses its placeholder; values in `allowlist` are not masked.
- The original-value ↔ placeholder mapping is kept **per session**. If a request carries `x-pii-session-id`, `anthropic-session-id`, or `x-session-id`, the mapping is tied to that ID (30-minute TTL); otherwise it lives only as long as the underlying TCP connection stays open. Sending `x-pii-session-reset: 1` discards that session's mapping. These control headers are not forwarded to upstream APIs.

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
ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
OPENAI_BASE_URL=http://127.0.0.1:8787/openai/v1
```

The proxy URL can be overridden with the `PII_PROXY_URL` environment variable (default `http://127.0.0.1:8787`). Actually sourcing/exporting this `.env` file into the shell that launches Claude Code is left to the user — `cloakroom` itself only writes the file.

To disable filtering entirely (pass everything through untouched): `CLAUDE_PII_FILTER=0 node dist/server.js`

### Using it with Hermes Agent

`cloakroom install --for=hermes-agent` writes `OPENAI_BASE_URL=http://127.0.0.1:8787/openai/v1` to `~/.hermes/.env`. Configure a Chat Completions custom provider in Hermes Agent:

```yaml
# ~/.hermes/config.yaml
providers:
  cloakroom:
    api: http://127.0.0.1:8787/openai/v1
    key_env: OPENAI_API_KEY
model: cloakroom:your-model-name
```

Requests through this provider use `/openai/v1/chat/completions`, which is routed to OpenAI and filtered. The user continues to manage their Hermes provider settings and API key.

## Configuration reference

Config file: `~/.claude/pii-filter.json` (created by `cloakroom init`, overwritten with `--force`). If it is missing or malformed, every field falls back to its default.

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off switch. When `false`, neither masking nor restoration runs |
| `maxRequestBodyBytes` | `67108864` (64 MiB) | Maximum request-body size. Requests above the limit receive `413 Payload Too Large` and are not sent upstream |
| `mode` | `"pseudonymize"` | `"pseudonymize"` uses reversible placeholders, `"anonymize"` uses placeholders that this application does not restore, and `"fake"` uses reversible dummy values. This is not legal anonymization |
| `placeholderFormat` | `"xml"` | `"xml"` uses `<pii:email id="1"/>`; set `"legacy"` for compatibility with clients that require the old format |
| `placeholderInstructionEnabled` | `false` | When `true`, adds a short instruction to the system/instructions field asking the model to preserve placeholders unchanged, but only when masking occurs |
| `blockNonText` | `false` | When `true`, rejects requests containing image, audio, video, or document blocks with `415`. When false, these payloads are passed through without inspection |
| `categories` | All 21 built-in categories except `URL_USER` | Enabled PII categories. `URL_USER` (Basic-auth-style userinfo in a URL) is not included by default and must be added explicitly |
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
| `include` | None | Loads one or more JSON config files using relative or absolute paths. Later files override earlier files; arrays replace earlier arrays |

`auditLog` is disabled by default. When enabled, it records the category, position, confidence, and mode; it includes the placeholder only when masking creates one. It does not record the original text. `destination: "stderr"` writes to standard error; `"file"` appends JSON Lines to `path` or `~/.claude/pii-audit.jsonl`. Newly created parent directories use mode `0700` and new log files use `0600`; existing file permissions are not changed and logs are not rotated automatically. `warn` skips masking and sends the original PII upstream, so the audit log does not prevent disclosure.

Environment variables:

| Variable | Description |
|---|---|
| `CLAUDE_PII_FILTER=0` | Skip reading the config file and start with filtering disabled |
| `PII_FILTER_CONFIG` | JSON config file to use. Defaults to `~/.claude/pii-filter.json`; `cloakroom init` writes to this path too |
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
| `POST /control/reload` | Reloads configuration and plugins while preserving existing session placeholder mappings |
| `POST /control/disable/<CATEGORY>` | Stops detecting a single category (unknown category returns 400) |
| `POST /control/enable/<CATEGORY>` | Resumes detecting a single category |

```bash
curl http://127.0.0.1:8787/control/status
curl -X POST http://127.0.0.1:8787/control/passthrough
curl -X POST http://127.0.0.1:8787/control/filter
curl -X POST http://127.0.0.1:8787/control/disable/PHONE
```

Sending `SIGUSR1` to the server process toggles passthrough mode (`kill -USR1 <pid>`). It is retained as a compatibility alias for existing setups; use the `/control` API for normal operations and status checks.

## Supported providers / APIs

| Provider | Filtered path | Upstream |
|---|---|---|
| Anthropic | `POST /anthropic/v1/messages`, `POST /anthropic/v1/messages/count_tokens` | `https://api.anthropic.com` |
| OpenAI-compatible | `POST /openai/v1/chat/completions`, `POST /openai/v1/responses` | `https://api.openai.com` |

Other paths can also be routed by using the `/anthropic/` or `/openai/` prefix; the prefix is removed before forwarding upstream. The legacy `x-provider` header no longer controls routing and is never forwarded. Known unprefixed API paths retain their existing routing; other unprefixed paths default to Anthropic. SSE is supported for Anthropic, OpenAI Chat Completions, and OpenAI Responses API.

## PII categories detected by regex

`EMAIL`, `PHONE` (Japanese and international formats), `ADDRESS` (Japanese addresses), `URL_USER` (credentials embedded in a URL), `API_KEY` (OpenAI, Anthropic, GitHub, Slack, Stripe, Google, and AWS formats; PEM private keys; JWTs; and contextual high-entropy tokens), `CREDIT_CARD` (Luhn-validated), `MY_NUMBER` (Japanese My Number format), `NAME` (only via Git's `Author:`/`Committer:` trailers), `SSN`, `IP_ADDRESS` (IPv4/IPv6), `POSTAL_CODE`. Secret values are never sent to an external service for verification. General detection of `NAME` / `ORG` / `SCHOOL` is handled by the heuristic NER stage (enabled by default), with the optional Ollama LLM stage further improving accuracy.

`fake` mode replaces values with reversible dummy data within a session: emails use `personN@example.com`, phone numbers `000-0000-NNNN`, names `匿名利用者N`, addresses `東京都架空市サンプルN丁目1-1`, URL credentials `userN:password@example.com`, and API keys `sk_test_placeholder_N`. IP addresses use the [RFC 5737](https://www.rfc-editor.org/rfc/rfc5737) documentation-only networks (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`); credit card values fail the Luhn check. Other categories use `sample-<category>-N`. If a dummy already appears in the same text or was issued earlier in the session, the counter advances to avoid a collision. `fake` is not the default (`pseudonymize` is), and per-category `fake` actions are not supported. `thinking` and `redacted_thinking` blocks remain unchanged so signed blocks are not broken.

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

## Privacy and disclaimer

- Cloakroom cannot fully detect PII and does not inspect image, audio, video, or document contents. Set `blockNonText: true` to reject requests containing these blocks. Otherwise, base64 and similar payloads are skipped for performance and sent upstream unchanged.
- This tool does not provide legal advice, certify compliance with privacy laws, or create legally anonymized information. Masking alone may not meet the legal definition; assess your purpose, data, and operation with the responsible privacy/legal team ([Personal Information Protection Commission of Japan](https://www.ppc.go.jp/personalinfo/tokumeikakouInfo/)).
- Anthropic states that it does not use conversations from its commercial services to train models unless users explicitly opt in or other stated exceptions apply. Retention and exceptions vary by product and contract, and this does not apply to other API providers. Check current terms for your account ([training data explanation](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training), [retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)). Cloakroom adds defense in depth to provider protections; it is not the only protection layer.
- `CLAUDE_PII_FILTER` and `~/.claude/pii-filter.json` remain for compatibility with existing installations. The current CLI/package name is `cloakroom`. Set `PII_FILTER_CONFIG` to use a different config path.
- Audit logs do not contain the original PII. However, `warn` leaves PII unmasked in the request sent upstream. File logs are not rotated automatically, so operators must manage file permissions, retention, deletion, and rotation.

## Limitations

- Heuristic NER is an approximate detector based on static surname/legal-entity/school-suffix dictionaries; surnames outside the dictionary, uncommon organization or school names, and unlisted romaji spellings can be missed. For higher accuracy, combine it with `ollamaEnabled: true` or register known values explicitly in `dictionary` / `customPatterns`
- Neither heuristic NER nor Ollama detection applies to the system prompt (the `system` field only goes through dictionary and regex filtering)
- Ollama's 4B model is not perfectly accurate for name/org/school detection; false positives and misses can occur. Detection has a timeout budget of roughly 4 seconds and adds latency per new content block
- When remote Ollama is enabled, unmasked text such as proper nouns may be sent to that host. Non-loopback `ollamaEndpoint` values are rejected by default; set `allowRemoteOllama: true` only when the host is trusted
- Runtime controls (passthrough, per-category disable) are process-wide, not per-session, and reset when the server restarts
- For clients that do not send an explicit session ID header, the mapping only lives as long as the TCP connection stays open; once it drops, previously issued placeholders can no longer be restored
- Only Anthropic Messages and OpenAI Chat Completions/Responses API paths are filtered; other paths are proxied without PII filtering
- Masking PII inside source code can affect code-generation accuracy
- Plugins execute local modules, so only configure trusted files in `plugins`. See [docs/multimodal-pii.md](docs/multimodal-pii.md) for the multimodal PII design

## License

MIT License. See [LICENSE](LICENSE) for details.
