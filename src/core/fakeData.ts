import type { PIICategory } from './types.js'

const FAKE_NAMES = ['山田太郎', '佐藤花子', '鈴木一郎', '高橋美咲', '田中健']

function padded(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

export function createFakeValue(category: PIICategory, count: number): string {
  switch (category) {
    case 'EMAIL':
      return `person${count}@example.com`
    case 'PHONE':
      return `090-0000-${padded(count, 4)}`
    case 'NAME': {
      const name = FAKE_NAMES[(count - 1) % FAKE_NAMES.length] ?? '山田太郎'
      const round = Math.floor((count - 1) / FAKE_NAMES.length)
      return round === 0 ? name : `${name}${round + 1}`
    }
    case 'CREDIT_CARD':
      return `4242 4242 4242 ${padded(4200 + count, 4)}`
    case 'ADDRESS':
      return `東京都架空区サンプル${count}丁目1-1`
    case 'URL_USER':
      return `https://user${count}:password@example.com`
    case 'API_KEY':
      return `sk_test_placeholder_${count}`
    default:
      return `sample-${String(category).toLowerCase()}-${count}`
  }
}
