/**
 * FPE Codec — per-category format handling, MAC verification, tweak derivation,
 * and response-text scanning for FF3-1 encoded tokens.
 *
 * Each masked token = FPE(digits) + 2-digit HMAC-SHA256 MAC.
 * No state is stored: encoding and decoding are purely deterministic functions
 * of the FPE key and category.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { encrypt, decrypt } from './fpe.js'
import { luhnCheck, myNumberCheck } from './regexFilter.js'
import type { PIICategory } from './types.js'

type FpeCategoryDef = {
  // Total lengths to scan for (encoded digit count + 2 MAC digits)
  readonly totalLengths: readonly number[]
  // Gate 3: validate that the FPE-decrypted digits represent a plausible value
  readonly validate: (digits: string) => boolean
}

const CATEGORY_DEFS: Record<string, FpeCategoryDef> = {
  PHONE: {
    totalLengths: [12, 13],  // 10-digit phone + 2 MAC, or 11-digit phone + 2 MAC
    validate: (d) => d.length === 10 || d.length === 11,
  },
  CREDIT_CARD: {
    totalLengths: [18],  // 16-digit PAN + 2 MAC
    validate: luhnCheck,
  },
  MY_NUMBER: {
    totalLengths: [14],  // 12-digit My Number + 2 MAC
    validate: myNumberCheck,
  },
}

// Reverse map: total token length → candidate categories
const LENGTH_TO_CATEGORIES = new Map<number, string[]>()
for (const [category, def] of Object.entries(CATEGORY_DEFS)) {
  for (const len of def.totalLengths) {
    const list = LENGTH_TO_CATEGORIES.get(len) ?? []
    list.push(category)
    LENGTH_TO_CATEGORIES.set(len, list)
  }
}

// Maximum encoded token length (CREDIT_CARD: 16 + 2 = 18, with headroom)
export const FPE_MAX_TOKEN_LENGTH = 30

/**
 * Derive a stable 8-byte tweak for a given category using HKDF-SHA256.
 * The tweak is not secret; it only needs to be unique per category.
 */
export function tweakFromCategory(category: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(`cloakroom-fpe-${category}`, 'utf8'), Buffer.alloc(0), '', 8),
  )
}

/**
 * Compute a 2-digit decimal MAC over the FPE-encoded string.
 * MAC = HMAC-SHA256(fpeKey, encoded)[0..1] reinterpreted as uint16 mod 100.
 */
function computeMac(fpeKey: Buffer, encoded: string): string {
  const hmac = createHmac('sha256', fpeKey)
  hmac.update(encoded, 'utf8')
  const digest = hmac.digest()
  const val = (((digest[0] ?? 0) * 256) + (digest[1] ?? 0)) % 100
  return val.toString().padStart(2, '0')
}

/**
 * Encode a digit string for a given category.
 * Returns the FPE ciphertext and the 2-digit MAC separately.
 * The full masked token placed in the text is `encoded + mac`.
 */
export function encodeWithFpe(
  category: PIICategory,
  digits: string,
  fpeKey: Buffer,
): { encoded: string; mac: string } {
  const tweak = tweakFromCategory(String(category))
  const encoded = encrypt(fpeKey, tweak, digits)
  const mac = computeMac(fpeKey, encoded)
  return { encoded, mac }
}

/**
 * Attempt to decode a candidate token for a given category.
 * Three gates: MAC check → FPE decrypt → category validation.
 * Returns the original digits on success, null on any gate failure.
 */
export function decodeWithFpe(
  category: PIICategory,
  candidate: string,
  fpeKey: Buffer,
): string | null {
  const def = CATEGORY_DEFS[String(category)]
  if (!def) return null
  if (candidate.length < 3) return null

  // Split encoded and MAC
  const mac = candidate.slice(-2)
  const encoded = candidate.slice(0, -2)

  // Gate 1: MAC verification
  if (computeMac(fpeKey, encoded) !== mac) return null

  // Gate 2: FPE decryption
  let original: string
  try {
    const tweak = tweakFromCategory(String(category))
    original = decrypt(fpeKey, tweak, encoded)
  } catch {
    return null
  }

  // Gate 3: category-specific validation
  if (!def.validate(original)) return null

  return original
}

/**
 * Scan text for FPE-encoded tokens and replace them with their original values.
 * Searches for isolated digit sequences whose lengths match known FPE token sizes.
 */
export function scanAndRestoreFpe(text: string, fpeKey: Buffer): string {
  return text.replace(/(?<!\d)\d+(?!\d)/g, (match) => {
    const categories = LENGTH_TO_CATEGORIES.get(match.length)
    if (!categories) return match
    for (const category of categories) {
      const decoded = decodeWithFpe(category, match, fpeKey)
      if (decoded !== null) return decoded
    }
    return match
  })
}
