# Claude Code PII Filter Fork

**Language**: [日本語](README-PII.md) | **English**

A fork of Claude Code CLI with PII (Personally Identifiable Information) filtering.
Detects and masks personal information from all data sent to the Anthropic API, and restores placeholders when displaying responses.

## Architecture

```
User input / Tool results / System prompts
  → Regex filter (EMAIL, PHONE, API_KEY, etc.)
  → Ollama 4B filter (person names, org names, etc.)
  → Placeholder replacement ([NAME_1], [EMAIL_2], etc.)
  → Anthropic API
  → Response received → Placeholder restoration → Display
```

## Setup

```bash
# 1. Install dependencies and build
npm --prefix pii-proxy install
npm --prefix pii-proxy run build

# 2. Create the config file
node pii-proxy/dist/cli.js init

# 3. Configure Claude Code to use the proxy
node pii-proxy/dist/cli.js install --for=claude-code

# 4. Start the proxy
node pii-proxy/dist/cli.js start
```

To enable Ollama-backed person and organization detection:

```bash
brew install ollama
brew services start ollama
ollama pull gemma3:4b
```

## Configuration

`~/.claude/pii-filter.json`:

```json
{
  "enabled": true,
  "categories": ["EMAIL","PHONE","NAME","ORG","ADDRESS","API_KEY","CREDIT_CARD","MY_NUMBER","SCHOOL"],
  "ollamaModel": "gemma3:4b",
  "ollamaEndpoint": "http://localhost:11434",
  "ollamaEnabled": true,
  "customPatterns": []
}
```

Disable: `CLAUDE_PII_FILTER=0 node dist/cli.js`

Runtime controls:

```bash
node pii-proxy/dist/cli.js status
curl -X POST http://127.0.0.1:8787/control/passthrough
curl -X POST http://127.0.0.1:8787/control/filter
curl -X POST http://127.0.0.1:8787/control/disable/PHONE
```

## Limitations

- Ollama 4B model accuracy for name detection is not perfect
- Adds 1-2 seconds latency per turn for new content blocks
- Code generation accuracy may be affected when PII in source files is masked
