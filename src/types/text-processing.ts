/**
 * A single find/replace rule for text processing.
 */
export interface TextProcessingRule {
  /** Regex pattern string or RegExp object */
  pattern: string | RegExp
  /** Regex flags (only used when pattern is a string). Defaults to 'g' */
  flags?: string
  /** Replacement string (supports $1, $2 capture group references) */
  replacement: string
}

/**
 * Configuration for the text processing pipeline stage.
 * All layers are optional. If none are configured, text passes through unchanged.
 */
export interface TextProcessingConfig {
  /** Enable built-in sanitization rules (default: false) */
  builtins?: boolean
  /** User-defined find/replace rules, applied in order */
  rules?: TextProcessingRule[]
  /** Custom transform function, applied last */
  transform?: (text: string) => string
}
