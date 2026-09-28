import { hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KEY_PATH = join(homedir(), '.claude', 'cloakroom-key')

// Load existing 32-byte master key from disk, or generate and persist a new one.
export function loadOrCreateKey(): Buffer {
  if (existsSync(KEY_PATH)) {
    const key = readFileSync(KEY_PATH)
    if (key.length === 32) return key
  }
  const key = randomBytes(32)
  // 0o600: owner read/write only — no group/world access
  writeFileSync(KEY_PATH, key, { mode: 0o600 })
  return key
}

// Derive a 32-byte purpose-specific key from a master key using HKDF-SHA256.
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), purpose, 32))
}
