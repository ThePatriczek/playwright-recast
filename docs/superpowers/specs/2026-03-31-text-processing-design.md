# Text Processing Pipeline Stage for TTS Sanitization

**Date:** 2026-03-31  
**Status:** Draft

## Context

Subtitle text in playwright-recast is sent directly to TTS providers (OpenAI, ElevenLabs) without any sanitization. Special characters like Czech curly quotes (`„` `"`), en/em dashes (`–` `—`), and other typographic symbols cause issues with voice synthesis — producing audible artifacts, mispronunciations, or API errors.

The demo app at `cdx-daemon/frontend/apps/demo` actively uses these characters in BDD feature file docStrings (e.g., `„Sledovaná judikatura"` in `sledovana-judikatura.feature`). Currently there is no processing layer between subtitle text extraction and TTS synthesis.

**Goal:** Add a configurable text processing stage to the pipeline that sanitizes subtitle text before voiceover generation. It must be controllable via the programmatic API, CLI, and config files.

## Architecture

### New Pipeline Stage: `.textProcessing()`

A new stage in the fluent Pipeline API, placed after subtitles and before voiceover. It mutates `SubtitledTrace.subtitles[].text` in place.

**Processing order (layered):**

```
subtitle.text
  → 1. Built-in rules (if builtins: true)
  → 2. User regex rules (if rules[] provided)  
  → 3. Custom transform function (if transform provided)
  → cleaned text
```

Each layer is optional. If no layers are configured, text passes through unchanged.

### Pipeline Position

```
parse → hideSteps → speedUp → subtitles → textProcessing → voiceover → render
```

The stage requires `SubtitledTrace` (subtitles must exist). It outputs the same `SubtitledTrace` with mutated text fields.

## Types

```typescript
// src/types/text-processing.ts

export interface TextProcessingRule {
  /** Regex pattern string or RegExp object */
  pattern: string | RegExp
  /** Regex flags (only used when pattern is a string) */
  flags?: string
  /** Replacement string (supports $1, $2 capture group references) */
  replacement: string
}

export interface TextProcessingConfig {
  /** Enable built-in sanitization rules (default: false) */
  builtins?: boolean
  /** User-defined find/replace rules, applied in order */
  rules?: TextProcessingRule[]
  /** Custom transform function, applied last */
  transform?: (text: string) => string
}
```

## Built-in Rules

When `builtins: true`, the following transformations are applied in order:

| Category | Characters | Replacement | Rationale |
|----------|-----------|-------------|-----------|
| Curly double quotes | `„` `"` `"` `"` `«` `»` | removed (empty string) | TTS reads these as pauses or garbage; removing them produces natural speech |
| Curly single quotes | `'` `'` `‚` `‛` `‹` `›` | removed (empty string) | Same issue as double quotes |
| Em dash | `—` (U+2014) | `, ` (comma + space) | Creates natural TTS pause |
| En dash | `–` (U+2013) | `, ` (comma + space) | Creates natural TTS pause |
| Horizontal ellipsis | `…` (U+2026) | `...` (three dots) | Normalize for TTS |
| Non-breaking space | `\u00A0` | regular space | Prevent word-joining issues |
| Multiple spaces | `/  +/` | single space | Cleanup after removals |
| Leading/trailing whitespace | — | trimmed | Clean output |

These rules are defined in a separate `builtins.ts` file for easy maintenance and testing.

## Programmatic API

### Simple usage (built-in defaults only)

```typescript
Recast.from(traceDir)
  .parse()
  .subtitlesFromSrt(srtPath)
  .textProcessing({ builtins: true })
  .voiceover(OpenAIProvider({ voice: 'nova' }))
  .render({ burnSubtitles: true })
  .toFile('output.mp4')
```

### Full configuration

```typescript
.textProcessing({
  builtins: true,
  rules: [
    // Expand abbreviations for TTS
    { pattern: '\\bNSS\\b', flags: 'g', replacement: 'Nejvyšší správní soud' },
    { pattern: '\\bNS\\b', flags: 'g', replacement: 'Nejvyšší soud' },
    // Remove markdown-like formatting
    { pattern: /\*\*(.*?)\*\*/g, replacement: '$1' },
  ],
  transform: (text) => {
    // Any custom logic
    return text.replace(/\s+/g, ' ').trim()
  },
})
```

### Disabled (default behavior, backwards compatible)

```typescript
// No .textProcessing() call = no processing = current behavior
Recast.from(dir).parse().subtitles(fn).voiceover(provider).render(cfg).toFile(out)
```

## CLI Interface

### Flags

```
--text-processing                Enable built-in text sanitization (builtins: true)
--text-processing-config <path>  Path to JSON config file with rules
```

### Config file format

```json
{
  "builtins": true,
  "rules": [
    { "pattern": "\\bNSS\\b", "flags": "g", "replacement": "Nejvyšší správní soud" },
    { "pattern": "[„""]", "flags": "g", "replacement": "" }
  ]
}
```

When both `--text-processing` and `--text-processing-config` are provided, the config file takes precedence. If the config file doesn't set `builtins`, it defaults to `false` unless `--text-processing` is also passed.

### CLI examples

```bash
# Built-in sanitization only
playwright-recast -i traces --provider openai --text-processing

# Custom config file
playwright-recast -i traces --provider openai --text-processing-config ./tts-rules.json

# Both: builtins + custom rules
playwright-recast -i traces --provider openai --text-processing --text-processing-config ./tts-rules.json
```

## File Structure

### New files

```
src/
  text-processing/
    text-processor.ts     # processText(text, config) — core logic
    builtins.ts           # BUILTIN_RULES array, applyBuiltins(text)
  types/
    text-processing.ts    # TextProcessingConfig, TextProcessingRule
```

### Modified files

| File | Change |
|------|--------|
| `src/pipeline/pipeline.ts` | Add `.textProcessing(config)` method |
| `src/pipeline/stages.ts` | Add `TextProcessingStage` descriptor |
| `src/pipeline/executor.ts` | Handle `textProcessing` stage in executor loop |
| `src/cli.ts` | Add `--text-processing` and `--text-processing-config` flags |
| `src/index.ts` | Export `TextProcessingConfig`, `TextProcessingRule`, `processText` |

## Implementation Details

### text-processor.ts

```typescript
export function processText(text: string, config: TextProcessingConfig): string {
  let result = text

  if (config.builtins) {
    result = applyBuiltins(result)
  }

  if (config.rules) {
    for (const rule of config.rules) {
      const regex = rule.pattern instanceof RegExp
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
```

### Executor stage handler

```typescript
case 'textProcessing': {
  if (!state.subtitled) throw new Error('textProcessing() requires subtitles() first')
  for (const subtitle of state.subtitled.subtitles) {
    subtitle.text = processText(subtitle.text, stage.config)
  }
  break
}
```

### CLI config loading

```typescript
if (argv['text-processing-config']) {
  const raw = fs.readFileSync(argv['text-processing-config'], 'utf-8')
  const config = JSON.parse(raw) as TextProcessingConfig
  if (argv['text-processing'] && config.builtins === undefined) {
    config.builtins = true
  }
  pipeline = pipeline.textProcessing(config)
} else if (argv['text-processing']) {
  pipeline = pipeline.textProcessing({ builtins: true })
}
```

## Demo App Integration

After the feature is implemented in playwright-recast, update the demo app:

**File:** `cdx-daemon/frontend/apps/demo/utils/recast-pipeline.ts`

Add `.textProcessing({ builtins: true })` to the pipeline before `.voiceover()`:

```typescript
pipeline = pipeline.subtitlesFromSrt(srtPath)
pipeline = pipeline.textProcessing({ builtins: true })  // NEW
pipeline = pipeline.voiceover(provider)
```

Optionally add CLI passthrough for the new flags.

## Verification

### Unit tests

1. **builtins.ts**: Test each built-in rule individually
   - Input `'Vybereme „Sledovanou judikaturu" pro monitoring'` → output `'Vybereme Sledovanou judikaturu pro monitoring'`
   - Input `'Zadáme téma – okamžité zrušení'` → output `'Zadáme téma, okamžité zrušení'`
   - Input with multiple spaces after removal → single space

2. **text-processor.ts**: Test layered processing
   - Builtins only
   - Rules only
   - Transform only
   - All three combined (verify order)
   - Empty/no config (passthrough)

3. **CLI config parsing**: Test JSON config loading and flag combinations

### Integration tests

4. **Pipeline stage**: Test that `.textProcessing()` stage correctly modifies subtitle text in the pipeline
   - Verify it requires subtitles stage
   - Verify it works with all subtitle sources (trace, SRT, BDD)

### End-to-end verification

5. Run the demo app's sledovana-judikatura feature with `--text-processing` enabled
6. Inspect generated SRT to verify cleaned text
7. Listen to generated voiceover audio to confirm no artifacts from special characters

## Backwards Compatibility

- **Default: OFF** — no processing unless explicitly enabled
- No existing API or CLI behavior changes
- New stage is optional in the pipeline
- `processText` exported for standalone use if needed
