import { PII_CATEGORIES, type PIICategory } from './types.js'

const knownCategories = new Set<string>(PII_CATEGORIES)
const disabledCategories = new Set<PIICategory>()

let passthroughEnabled = false

export type PIIControlStatus = {
  readonly passthroughEnabled: boolean
  readonly disabledCategories: readonly PIICategory[]
}

export function isPassthroughEnabled(): boolean {
  return passthroughEnabled
}

export function setPassthroughEnabled(enabled: boolean): PIIControlStatus {
  passthroughEnabled = enabled
  return getControlStatus()
}

export function togglePassthrough(): PIIControlStatus {
  passthroughEnabled = !passthroughEnabled
  return getControlStatus()
}

export function isKnownPIICategory(category: string): category is PIICategory {
  return knownCategories.has(category)
}

export function disableCategory(category: PIICategory): PIIControlStatus {
  disabledCategories.add(category)
  return getControlStatus()
}

export function enableCategory(category: PIICategory): PIIControlStatus {
  disabledCategories.delete(category)
  return getControlStatus()
}

export function resetControlState(): PIIControlStatus {
  passthroughEnabled = false
  disabledCategories.clear()
  return getControlStatus()
}

export function getActiveCategories(categories: readonly PIICategory[]): readonly PIICategory[] {
  if (disabledCategories.size === 0) return categories
  return categories.filter((category) => !disabledCategories.has(category))
}

export function getControlStatus(): PIIControlStatus {
  return {
    passthroughEnabled,
    disabledCategories: [...disabledCategories].sort(),
  }
}
