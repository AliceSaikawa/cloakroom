import type { PIICategory } from './types.js'

const TEST_NET_PREFIXES = ['192.0.2.', '198.51.100.', '203.0.113.']

function padded(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

function hasValidLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  let sum = 0
  let doubleDigit = false

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (doubleDigit) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubleDigit = !doubleDigit
  }

  return sum % 10 === 0
}

export function createFakeValue(category: PIICategory, count: number): string {
  switch (category) {
    case 'EMAIL':
      return `person${count}@example.com`
    case 'PHONE':
      return `000-0000-${padded(count, 4)}`
    case 'NAME':
      return `匿名利用者${count}`
    case 'CREDIT_CARD': {
      let candidate = count
      let digits = `000000000000${padded(candidate, 4)}`
      while (hasValidLuhn(digits)) {
        candidate += 1
        digits = `000000000000${padded(candidate, 4)}`
      }
      return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)} ${digits.slice(12)}`
    }
    case 'ADDRESS':
      return `東京都架空市サンプル${count}丁目1-1`
    case 'URL_USER':
      return `https://user${count}:password@example.com`
    case 'API_KEY':
      return `sk_test_placeholder_${count}`
    case 'IP_ADDRESS': {
      const index = count - 1
      const networkIndex = Math.floor(index / 254)
      const host = (index % 254) + 1
      const prefix = TEST_NET_PREFIXES[networkIndex]
      return prefix ? `${prefix}${host}` : `sample-ip_address-${count}`
    }
    default:
      return `sample-${String(category).toLowerCase()}-${count}`
  }
}
