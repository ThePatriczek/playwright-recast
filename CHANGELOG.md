# Changelog

## 0.4.0 (2026-03-31)

### Features

- **Text processing pipeline stage** — New `.textProcessing(config)` stage sanitizes subtitle text before TTS synthesis. Removes typographic characters (smart quotes, guillemets, em/en dashes, ellipsis) that cause artifacts in voice models. Supports three processing layers applied in order: built-in rules, user-defined regex rules, and custom transform functions.
- **Separate TTS text from display text** — Text processing writes to `ttsText` field on subtitle entries. Voiceover uses cleaned text while burnt-in subtitles and SRT/VTT output preserve the original text.
- **CLI flags** — `--text-processing` enables built-in sanitization, `--text-processing-config <path>` loads custom rules from a JSON file.
- **Standalone `processText()` export** — Use the text processing engine outside the pipeline for custom workflows.

### Built-in Rules

When `builtins: true`:
- Remove curly/guillemet double quotes: `"` `"` `"` `„` `«` `»` and ASCII `"`
- Remove curly/guillemet single quotes: `'` `'` `‚` `‛` `‹` `›`
- Em dash (`—`) and en dash (`–`) with surrounding spaces → `, `
- Horizontal ellipsis (`…`) → `...`
- Non-breaking space → regular space
- Collapse multiple spaces, trim

## 0.3.2

- Increase timeout for long-running trace processing

## 0.3.1

- Initial public release with fluent pipeline API, TTS voiceover (OpenAI, ElevenLabs), subtitle generation, speed processing, zoom, and CLI
