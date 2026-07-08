#!/bin/bash
set -euo pipefail

STATUS_FILE="$HOME/.claude/statusline-state.json"

update_status() {
  local state="$1"
  node -e '
const fs = require("fs");
const p = process.argv[1];
const state = process.argv[2];
let obj = {};
try { obj = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
obj.pii_proxy = { state, updated_at: new Date().toISOString() };
fs.writeFileSync(p, JSON.stringify(obj, null, 2));
' "$STATUS_FILE" "$state" >/dev/null 2>&1 || true
}

cleanup() {
  update_status "stopped"
}

CONFIG_PATH="$HOME/.claude/pii-filter.json"
OLLAMA_ENABLED=$(node -e '
const fs = require("fs");
try {
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log(cfg.ollamaEnabled === true ? "true" : "false");
} catch {
  console.log("false");
}
' "$CONFIG_PATH" 2>/dev/null || echo "false")

# Ollama起動チェックは ollamaEnabled=true のときのみ意味を持つ。未起動でも
# プロキシ自体の起動は止めず、警告のみ表示する(辞書・正規表現によるフィルタは
# Ollama無しでも動作するため)。
if [ "$OLLAMA_ENABLED" = "true" ] && ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
  echo "警告: ollamaEnabled=true ですが Ollama (http://localhost:11434) に接続できません。'ollama serve' を起動してください。Ollama検出は今回の起動ではスキップされます。" >&2
fi

update_status "running"
node "$(dirname "$0")/dist/server.js"
cleanup
