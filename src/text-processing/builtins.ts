import type { TextProcessingRule } from '../types/text-processing.js'

/**
 * Built-in sanitization rules for TTS text processing.
 * Applied in order: removals first, then replacements, then cleanup.
 */
export const BUILTIN_RULES: readonly TextProcessingRule[] = [
  // Remove double quotes (curly, guillemet, and ASCII)
  { pattern: '[„\u201C\u201D\u201F\u00AB\u00BB"]', flags: 'g', replacement: '' },
  // Remove single quotes (curly and guillemet — NOT ASCII apostrophe)
  { pattern: '[\u2018\u2019\u201A\u201B\u2039\u203A]', flags: 'g', replacement: '' },
  // Em dash (with optional surrounding spaces) → comma + space
  { pattern: '\\s*\u2014\\s*', flags: 'g', replacement: ', ' },
  // En dash (with optional surrounding spaces) → comma + space
  { pattern: '\\s*\u2013\\s*', flags: 'g', replacement: ', ' },
  // Horizontal ellipsis → three dots
  { pattern: '\u2026', flags: 'g', replacement: '...' },
  // Non-breaking space → regular space
  { pattern: '\u00A0', flags: 'g', replacement: ' ' },
  // Collapse multiple spaces
  { pattern: ' {2,}', flags: 'g', replacement: ' ' },
]

/**
 * Apply all built-in sanitization rules to text.
 */
export function applyBuiltins(text: string): string {
  let result = text

  for (const rule of BUILTIN_RULES) {
    const regex = new RegExp(rule.pattern as string, rule.flags ?? 'g')
    result = result.replace(regex, rule.replacement)
  }

  return result.trim()
}
