# Cloakroom

**Language**: [日本語](README.md) | **English**

Checks your PII at the door, hands the API a ticket, and gives everything back on the way out.

A local HTTP proxy that sits between Claude Code (or any Anthropic API / OpenAI-compatible client) and the upstream API. It detects personally identifiable information (PII) in the request body, replaces it with placeholders, and restores the original values right before the response is displayed.

## How it works

```
Claude Code / API client
        │  ANTHROPIC_BASE_URL / OPENAI_BASE_URL → http://127.0.0.1:8787
        ▼
┌───────────────────────────────────────────────┐
│  Cloakroom proxy (127.0.0.1:8787)              │
│                                                 │
│  1. Dictionary exact match  (config.dictionary)│
│  2. Regex match      (built-in + customPatterns)│
│  3. Ollama LLM match  (NAME/ORG/SCHOOL, optional)│
│       ↓                                         │
│  Placeholder registration → [EMAIL_1] [NAME_2]  │
│  (per-session MappingTable)                     │
└───────────────────────────────────────────────┘
        │ masked request
        ▼
  Anthropic API        (POST /v1/messages)
  OpenAI-compatible API (POST /v1/chat/completions)
  Any other path        (passed through untouched)
        │ response (JSON or SSE)
        ▼
┌───────────────────────────────────────────────┐
│  Placeholder restoration                        │
│  - Non-streaming: recursive walk over the JSON  │
│  - Streaming: buffers text_delta /               │
│    choices[].delta so placeholders split across │
│    chunk boundaries still resolve correctly      │
└───────────────────────────────────────────────┘
        │ restored response
        ▼
Claude Code / API client
```

- Detection happens in three stages: **dictionary (exact match) → regex → Ollama LLM (optional)**. The Ollama LLM stage is disabled by default (`ollamaEnabled: false`); when enabled, it only handles the `NAME` / `ORG` / `SCHOOL` categories, and is skipped entirely if none of those are in the active category list.
- Ollama detection is **not applied to the system prompt** (the `system` field is only filtered by dictionary and regex). Only user/assistant message content and tool results go through Ollama.
- Placeholders use the format `[CATEGORY_N]` (e.g. `[EMAIL_1]`, `[NAME_2]`). The same original value always reuses the same placeholder. Values in `allowlist` are never masked.
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

Ollama-backed person/organization/school detection is an **optional feature, disabled by default**. Set `ollamaEnabled: true` in the config file to enable it. When enabled, it requires Ollama itself plus the target model (`gemma3:4b`):

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

## Configuration reference

Config file: `~/.claude/pii-filter.json` (created by `cloakroom init`, overwritten with `--force`). If it is missing or malformed, every field falls back to its default.

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master on/off switch. When `false`, neither masking nor restoration runs |
| `categories` | `["EMAIL","PHONE","ADDRESS","API_KEY","CREDIT_CARD","MY_NUMBER","NAME","ORG","SCHOOL","SSN","IP_ADDRESS","POSTAL_CODE"]` | Enabled PII categories. Of the 13 defined categories, `URL_USER` (Basic-auth-style userinfo in a URL) is not included by default and must be added explicitly |
| `ollamaEndpoint` | `"http://localhost:11434"` | Ollama API endpoint |
| `ollamaModel` | `"gemma3:4b"` | Ollama model to use |
| `ollamaEnabled` | `false` | Whether Ollama-backed `NAME`/`ORG`/`SCHOOL` detection runs (optional feature, disabled by default) |
| `customPatterns` | `[]` | Extra regex patterns ({`name`, `pattern`}). **Matches are always registered under the `NAME` category** (the `name` field is kept only as a label, not used for categorization) |
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
cloakroom init [--yes] [--force]
cloakroom install --for=claude-code
cloakroom status
cloakroom test
```

- `start` — spawns `dist/server.js` as a child process
- `init [--force]` — creates `~/.claude/pii-filter.json`. Does nothing if it already exists and `--force` is not passed (`--yes` is listed in the help text but is currently unused by the implementation)
- `install --for=claude-code` — writes the `~/.claude/.env` settings described above. Any other `--for` value throws an error
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

`EMAIL`, `PHONE` (Japanese and international formats), `ADDRESS` (Japanese addresses), `URL_USER` (credentials embedded in a URL), `API_KEY` (`sk-`, `ghp_`, `gho_`, `github_pat_`, `AKIA`, `xox[bpras]-`, `sk-ant-`, etc.), `CREDIT_CARD` (Luhn-validated), `MY_NUMBER` (Japanese My Number format), `NAME` (only via Git's `Author:`/`Committer:` trailers — general name detection is handled by Ollama), `SSN`, `IP_ADDRESS` (IPv4/IPv6), `POSTAL_CODE`. General detection of `NAME` / `ORG` / `SCHOOL` is handled by the Ollama LLM stage.

## Tests

| Command | What it checks | Requires |
|---|---|---|
| `node test-pii-filter.mjs` | Filter ON/OFF, bug regressions, provider routing, stream restoration, runtime control | None (bundles source on the fly with esbuild) |
| `node test-pii-filter.mjs --proxy` | Same as above, plus a scenario that hits a running proxy for real | A running proxy and `ANTHROPIC_API_KEY` set |
| `node test-integrated.mjs` | Accuracy of the full regex + Ollama detection pipeline | Only relevant when running with `ollamaEnabled: true`. **Ollama running locally** with `gemma3:4b` pulled |
| `node test-hard-cases.mjs` | Hard edge cases for Ollama detection (e.g. names vs. common nouns) | Only relevant when running with `ollamaEnabled: true`. **Ollama running locally** |
| `node test-ollama-pii-v2.mjs` | Accuracy of the Ollama detection prompt itself | Only relevant when running with `ollamaEnabled: true`. **Ollama running locally** |

## Limitations

- With Ollama disabled (the default), proper nouns such as names, organizations, and schools are only masked if registered in `dictionary` / `customPatterns` (no automatic detection). Set `ollamaEnabled: true` to enable automatic detection
- Ollama detection does not apply to the system prompt (the `system` field only goes through dictionary and regex filtering)
- Ollama's 4B model is not perfectly accurate for name/org/school detection; false positives and misses can occur. Detection has a timeout budget of roughly 4 seconds and adds latency per new content block
- Runtime controls (passthrough, per-category disable) are process-wide, not per-session, and reset when the server restarts
- For clients that do not send an explicit session ID header, the mapping only lives as long as the TCP connection stays open; once it drops, previously issued placeholders can no longer be restored
- Matches from `customPatterns` are always tagged as `NAME`, regardless of the pattern's given `name`
- Paths other than `/v1/messages` and `/v1/chat/completions` are proxied without any PII filtering
- Masking PII inside source code can affect code-generation accuracy
- The `input` field of an assistant `tool_use` block is not filtered (by design, `filterContent` in `src/piiFilter.ts` passes it through untouched). When conversation history is resent, raw PII embedded in tool call arguments (e.g., file paths containing real names) is sent upstream unmasked
