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

update_status "running"
node "$(dirname "$0")/dist/server.js"
cleanup
