# Changelog

## 0.5.0 (2026-03-31)

### Features

- **Smooth zoom transitions** — Zoom in/out uses fade-overlay blending between full view and zoomed view from the same source frames. No ghosting or element jumping.
- **Improved auto-zoom from trace** — Detects `fill`/`type` input actions from Playwright trace with configurable zoom levels per action type (`clickLevel`, `inputLevel`, `idleLevel`). Zoom window follows actual action duration from trace, not full subtitle timing.
- **Zoom window timing** — `StepZoom` now supports `startMs`/`endMs` for precise zoom windows independent of subtitle duration. Auto-zoom sets these from trace action boundaries.
- **Center bias** — `centerBias` option blends zoom coordinates toward viewport center for more balanced framing.
- **Configurable zoom via JSON** — Demo pipeline loads zoom overrides from `zoom-config.json` alongside test results.

### Fixes

- **Fix zoom cropping entire video** — `isnan(t)` guard prevents ffmpeg crop filter from locking output dimensions at zoom level during config-time evaluation where `t` is NaN.
- **Fix crop coordinates using wrong resolution** — Zoom now probes actual source video dimensions instead of using target resolution for crop math.

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
