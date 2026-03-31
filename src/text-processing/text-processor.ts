import type { TextProcessingConfig } from '../types/text-processing.js'
import { applyBuiltins } from './builtins.js'

/**
 * Process subtitle text through configured layers.
 * Layers are applied in order: builtins → user rules → custom transform.
 */
export function processText(text: string, config: TextProcessingConfig): string {
  let result = text

  if (config.builtins) {
    result = applyBuiltins(result)
  }

  if (config.rules) {
    for (const rule of config.rules) {
      const regex =
        rule.pattern instanceof RegExp
          ? rule.pattern
          : new RegExp(rule.pattern, rule.flags ?? 'g')
      result = result.replace(regex, rule.replacement)
    }
  }

  if (config.transform) {
    result = config.transform(result)
  }

  return result
}
