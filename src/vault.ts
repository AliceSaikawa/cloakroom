import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { deriveKey, loadOrCreateKey } from './keys.js'
import type { VaultData } from './types.js'

// Re-export for backward compatibility.
export { loadOrCreateKey } from './keys.js'

const VAULT_DIR = join(homedir(), '.claude', 'cloakroom-vault')

function ensureVaultDir(): void {
  if (!existsSync(VAULT_DIR)) {
    mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 })
  }
}

// Sanitize session ID to prevent path traversal
function vaultFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(VAULT_DIR, `${safe}.vault`)
}

// Encrypt data string with AES-256-GCM.
// Output format: [iv(12 bytes)][authTag(16 bytes)][ciphertext]
export function encryptData(data: string, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted])
}

// Decrypt buffer produced by encryptData.
export function decryptData(ciphertext: Buffer, key: Buffer): string {
  const iv = ciphertext.subarray(0, 12)
  const authTag = ciphertext.subarray(12, 28)
  const encrypted = ciphertext.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}

function vaultKey(): Buffer {
  return deriveKey(loadOrCreateKey(), 'cloakroom-vault-v1')
}

export function saveSessionVault(sessionId: string, data: VaultData): void {
  ensureVaultDir()
  const key = vaultKey()
  const json = JSON.stringify(data)
  const encrypted = encryptData(json, key)
  writeFileSync(vaultFilePath(sessionId), encrypted, { mode: 0o600 })
}

export function loadSessionVault(sessionId: string): VaultData | null {
  const filePath = vaultFilePath(sessionId)
  if (!existsSync(filePath)) return null
  try {
    const key = vaultKey()
    const ciphertext = readFileSync(filePath)
    const json = decryptData(ciphertext, key)
    return JSON.parse(json) as VaultData
  } catch {
    // Corrupt or tampered file (or encrypted with old key) — treat as absent
    return null
  }
}

export function deleteSessionVault(sessionId: string): void {
  const filePath = vaultFilePath(sessionId)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

// Remove vault files whose mtime is older than ttlMs milliseconds.
export function cleanExpiredVaults(ttlMs: number): void {
  if (!existsSync(VAULT_DIR)) return
  const now = Date.now()
  for (const file of readdirSync(VAULT_DIR)) {
    if (!file.endsWith('.vault')) continue
    const filePath = join(VAULT_DIR, file)
    try {
      const stat = statSync(filePath)
      if (now - stat.mtimeMs > ttlMs) {
        unlinkSync(filePath)
      }
    } catch {
      // Skip files we can't stat
    }
  }
}
