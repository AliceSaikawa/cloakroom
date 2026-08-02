/**
 * FF3-1 Format-Preserving Encryption (NIST SP 800-38G Rev. 1)
 * Radix=10 fixed, AES-256-ECB inverse cipher only.
 * Key: 32 bytes (AES-256). Tweak: 8 bytes. Input: digit string, min 6 chars.
 */
import { createDecipheriv } from 'node:crypto'

const RADIX = 10n

function revBuf(b: Buffer): Buffer {
  // Byte-level reversal (REVB in the spec)
  const out = Buffer.allocUnsafe(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i] ?? 0
  return out
}

function revStr(s: string): string {
  // Symbol-level reversal (REV in the spec)
  return s.split('').reverse().join('')
}

function numFromDigits(s: string): bigint {
  // NUMradix: convert a digit string to a bigint (base 10)
  let result = 0n
  for (const ch of s) result = result * RADIX + BigInt(parseInt(ch, 10))
  return result
}

function digitsFromNum(n: bigint, length: number): string {
  // STR_m_radix: convert bigint to zero-padded digit string of given length
  const digits: number[] = []
  let rem = n
  for (let i = 0; i < length; i++) {
    digits.unshift(Number(rem % RADIX))
    rem = rem / RADIX
  }
  return digits.join('')
}

function numToBytes12(n: bigint): Buffer {
  // Encode bigint as 12-byte big-endian buffer
  const buf = Buffer.alloc(12)
  let tmp = n
  for (let j = 11; j >= 0; j--) {
    buf[j] = Number(tmp & 0xffn)
    tmp >>= 8n
  }
  return buf
}

function aes256EcbDecrypt(key: Buffer, block: Buffer): Buffer {
  // AES-256-ECB decryption (the "inverse cipher" used in FF3-1 round function)
  const dec = createDecipheriv('aes-256-ecb', key, null)
  dec.setAutoPadding(false)
  return Buffer.concat([dec.update(block), dec.final()])
}

function ff3S(key: Buffer, P: Buffer): Buffer {
  // S = REVB(AES_K*_inverse(REVB(P)))
  return revBuf(aes256EcbDecrypt(key, revBuf(P)))
}

function buildP(W: Buffer, i: number, half: string): Buffer {
  // P = (W XOR [i as 4 bytes BE]) || [NUMradix(REV(half)) as 12 bytes BE]
  const iBytes = Buffer.alloc(4)
  iBytes.writeUInt32BE(i, 0)
  const WxorI = Buffer.alloc(4)
  for (let j = 0; j < 4; j++) WxorI[j] = (W[j] ?? 0) ^ (iBytes[j] ?? 0)
  return Buffer.concat([WxorI, numToBytes12(numFromDigits(revStr(half)))])
}

/**
 * FF3-1 encryption.
 * @param key  32-byte AES-256 key
 * @param tweak  8-byte tweak
 * @param numStr  digit string (minimum 6 characters)
 * @returns encrypted digit string of the same length
 */
export function encrypt(key: Buffer, tweak: Buffer, numStr: string): string {
  if (numStr.length < 6) throw new Error('FF3-1: minimum 6 digits required')

  // K* = REVB(K) per the spec
  const K = revBuf(key)
  const n = numStr.length
  const u = Math.ceil(n / 2)
  const v = n - u

  const TL = tweak.slice(0, 4)  // T[0..3]
  const TR = tweak.slice(4, 8)  // T[4..7]

  let A = numStr.slice(0, u)
  let B = numStr.slice(u)

  for (let i = 0; i < 8; i++) {
    const m = i % 2 === 0 ? u : v
    const W = i % 2 === 0 ? TR : TL

    // Round function: compute y from the B-side half
    const S = ff3S(K, buildP(W, i, B))
    let y = 0n
    for (const byte of S) y = (y << 8n) | BigInt(byte)

    // c = (NUMradix(REV(A)) + y) mod radix^m
    const radixM = RADIX ** BigInt(m)
    const c = (numFromDigits(revStr(A)) + y) % radixM

    // C = REV(STR_m_radix(c)); then Feistel swap
    const C = revStr(digitsFromNum(c, m))
    A = B
    B = C
  }

  return A + B
}

/**
 * FF3-1 decryption.
 * @param key  32-byte AES-256 key
 * @param tweak  8-byte tweak
 * @param numStr  digit string (minimum 6 characters)
 * @returns decrypted digit string of the same length
 */
export function decrypt(key: Buffer, tweak: Buffer, numStr: string): string {
  if (numStr.length < 6) throw new Error('FF3-1: minimum 6 digits required')

  const K = revBuf(key)
  const n = numStr.length
  const u = Math.ceil(n / 2)
  const v = n - u

  const TL = tweak.slice(0, 4)
  const TR = tweak.slice(4, 8)

  let A = numStr.slice(0, u)
  let B = numStr.slice(u)

  for (let i = 7; i >= 0; i--) {
    const m = i % 2 === 0 ? u : v
    const W = i % 2 === 0 ? TR : TL

    // In decryption the round function uses A (the current left half = old B from forward)
    const S = ff3S(K, buildP(W, i, A))
    let y = 0n
    for (const byte of S) y = (y << 8n) | BigInt(byte)

    // c = (NUMradix(REV(B)) - y) mod radix^m
    const radixM = RADIX ** BigInt(m)
    const c = ((numFromDigits(revStr(B)) - y) % radixM + radixM) % radixM

    const C = revStr(digitsFromNum(c, m))
    B = A
    A = C
  }

  return A + B
}
