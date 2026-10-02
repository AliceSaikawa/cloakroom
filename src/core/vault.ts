import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
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

type VaultProvider = 'anthropic' | 'openai'

function vaultDir(provider?: VaultProvider): string {
  return provider ? join(VAULT_DIR, provider) : VAULT_DIR
}

function ensureVaultDir(provider?: VaultProvider): void {
  const directory = vaultDir(provider)
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
}

// Sanitize session ID to prevent path traversal
function vaultFilePath(sessionId: string, provider?: VaultProvider): string {
  if (provider) {
    // Separate directories never fall back to ambiguous legacy shared vaults.
    const id = createHash('sha256').update(sessionId, 'utf8').digest('hex')
    return join(vaultDir(provider), `${id}.vault`)
  }
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

export function saveSessionVault(sessionId: string, data: VaultData, provider?: VaultProvider): void {
  ensureVaultDir(provider)
  const key = vaultKey()
  const json = JSON.stringify(data)
  const encrypted = encryptData(json, key)
  writeFileSync(vaultFilePath(sessionId, provider), encrypted, { mode: 0o600 })
}

export function loadSessionVault(sessionId: string, provider?: VaultProvider): VaultData | null {
  const filePath = vaultFilePath(sessionId, provider)
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

export function deleteSessionVault(sessionId: string, provider?: VaultProvider): void {
  const filePath = vaultFilePath(sessionId, provider)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

// Remove vault files whose mtime is older than ttlMs milliseconds.
export function cleanExpiredVaults(ttlMs: number): void {
  const now = Date.now()
  for (const directory of [vaultDir(), vaultDir('anthropic'), vaultDir('openai')]) {
    if (!existsSync(directory)) continue
    for (const file of readdirSync(directory)) {
      if (!file.endsWith('.vault')) continue
      const filePath = join(directory, file)
      try {
        const stat = statSync(filePath)
        if (now - stat.mtimeMs > ttlMs) unlinkSync(filePath)
      } catch {
        // Skip files we can't stat
      }
    }
  }
}
