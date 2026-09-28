import type { PIICategory, PIIFilterConfig } from './types.js'

function getConfiguredCategories(config: PIIFilterConfig): readonly PIICategory[] {
  const customCategories = config.customCategories
    .filter((category) => category.enabled !== false)
    .map((category) => category.name)
  const customPatternCategories = config.customPatterns.map((pattern) => pattern.category ?? pattern.name)
  return [...new Set([...config.categories, ...customCategories, ...customPatternCategories])]
}

export function resolveConfiguredCategory(
  requestedCategory: string,
  config: PIIFilterConfig,
): PIICategory | undefined {
  const configuredCategories = getConfiguredCategories(config)
  const exactMatch = configuredCategories.find((category) => category === requestedCategory)
  if (exactMatch) return exactMatch

  const normalized = requestedCategory.toLocaleLowerCase()
  return configuredCategories.find((category) => category.toLocaleLowerCase() === normalized)
}
