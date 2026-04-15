# Changelog

## 0.14.0 (2026-04-15)

### Features

- **Amazon Polly TTS provider** ([#3](https://github.com/ThePatriczek/playwright-recast/issues/3)) — Added `PollyProvider` for Amazon Polly, alongside OpenAI and ElevenLabs. Supports `standard`, `neural`, `long-form`, and `generative` engines, all Polly voices, and SSML input. Credentials resolved via the AWS SDK default chain (env vars, shared config, IAM role on EC2/ECS/Lambda) — no explicit keys required when running on AWS infra. Wired through CLI (`--provider polly`), MCP (`ttsProvider: "polly"`), and auto-detected when `AWS_ACCESS_KEY_ID` or `AWS_PROFILE` is set. Requires `@aws-sdk/client-polly` as an optional peer dep. Docs: [`/docs/providers/polly`](https://playwright-recast.dev/docs/providers/polly).

## 0.13.2 (2026-04-10)

### Bug fixes

- **Recorder failed on hoisted/flat `node_modules` layouts** — `recorder.ts` hardcoded a lookup for `packageRoot/node_modules/playwright/index.mjs`, assuming a nested install. In flat layouts (npm, bun, pnpm, npx) `playwright` is hoisted as a sibling, so dynamic import failed with `Cannot find module '.../playwright-recast/node_modules/playwright/index.mjs'`. Replaced with a plain `await import('playwright')` that goes through Node's ESM module resolution and picks `index.mjs` via the package `exports.import` condition. Works on npm, bun, pnpm, npx, and nested installs — and cross-platform (Mac/Linux/Windows).
- **MCP plugin `.mcp.json` missing peer deps in npx install** — Plugin config ran `npx -y -p playwright-recast recast-mcp`, which only fetched `playwright-recast` into the ephemeral npx cache — `@playwright/test`, `playwright`, `openai`, and `@elevenlabs/elevenlabs-js` (optional peer deps) were not installed, so the recorder and voiceover providers crashed at runtime. Added `-p @playwright/test -p openai -p @elevenlabs/elevenlabs-js` to the npx args so a fresh plugin install resolves all peer deps into the same cache directory. The plugin now "just works" after installing the marketplace — no manual peer dep setup required.

## 0.13.1 (2026-04-09)

### Bug fixes

- **Windows ESM import error** — Dynamic `import()` of Playwright module failed on Windows because `path.join()` produces `C:\...` paths which are not valid ESM import specifiers. Fixed with `pathToFileURL()` conversion.
- **npx package resolution** — `npx recast-mcp` downloaded the wrong npm package (`recast-mcp@0.2.0`, a social media tool). All docs and configs updated to `npx -y -p playwright-recast recast-mcp`.

## 0.13.0 (2026-04-09)

### Features

- **MCP server: recording-first workflow** — Complete recording → analyze → render pipeline via MCP tools. Record a browser session with `record_session`, analyze with `analyze_trace`, write voiceover, and render with `render_video`.
- **DOM action tracking** — Recorder captures user interactions (click, fill, press, goto) via `page.exposeFunction()` during `page.pause()` sessions. Actions include click coordinates for visual effects. Saved to `_recorded-actions.json`.
- **Pipeline `injectActions()` stage** — New pipeline method to merge DOM-tracked synthetic actions into the parsed trace. Enables clickEffect, cursorOverlay, and autoZoom for recording-first workflows where trace doesn't contain user-facing actions.
- **Hidden step cutting** — Hidden steps are completely cut from the output video (not just sped up). Uses explicit speed segments with 9999x for hidden periods + merge of adjacent hidden ranges within 2s to eliminate gaps. Login flows with credentials are fully removed.
- **MCP env configuration** — All rendering defaults configurable via environment variables: `RECAST_RESOLUTION`, `RECAST_FPS`, `RECAST_INTRO_PATH`, `RECAST_OUTRO_PATH`, `RECAST_CLICK_SOUND`, `RECAST_BACKGROUND_MUSIC`, `RECAST_BACKGROUND_MUSIC_VOLUME`, `RECAST_TTS_VOICE`, `RECAST_TTS_MODEL`.
- **Background music support in MCP** — `render_video` now supports background music with auto-ducking during voiceover. Configurable via settings or env vars.
- **Intro/outro from config** — Default intro/outro video paths loaded from MCP env config, no need to pass in every render call.
- **Resolution-aware subtitle styling** — Subtitle font size, padding, margins scale automatically based on output resolution (4k/1440p/1080p/720p).

### Breaking Changes

- **Removed `get_step_thumbnail` MCP tool** — Thumbnails from trace screencast frames were unreliable with `page.pause()` recordings. Removed tool and thumbnail generation from analyzer.
- **Default resolution changed to 4k** — Was 1080p, now 4k with 120fps by default.
- **Default ElevenLabs voice changed** — Hardcoded fallback voice ID updated to `3HdFueVb2f3yUQzeEpyz`.

### Bug fixes

- **MCP recorder stdio corruption** — Changed from `spawnSync` with `stdio: 'inherit'` to async `spawn` with piped stdio. Prevents JSON-RPC protocol corruption when running from MCP server.
- **Module resolution in recorder** — Playwright binaries resolved from `packageRoot/node_modules/.bin/` with `NODE_PATH` set, fixing `Cannot find module '@playwright/test'` errors.
- **Hidden steps not applied** — Fixed timestamp alignment between DOM-tracked actions and trace monotonic time. Speed segments now use 0-based relative timestamps matching speed processor's baseline convention.
- **Renderer skipping speed processing** — Fixed: renderer's `hasSpeed` check requires at least one non-1x segment. Hidden ranges now use 9999x speed to trigger processing.
- **Login visible in output** — Fixed: adjacent hidden ranges merged (2s tolerance) to prevent tiny visible gaps between login steps. Synthetic actions from hidden periods filtered before injection.
- **Click sounds from hidden actions** — Fixed: only visible-period DOM actions are injected into pipeline, preventing click effects during intro/hidden periods.
- **Hook matcher names** — Plugin hooks updated from `mcp__recast__*` to `mcp__plugin_playwright-recast_recast__*` to match Claude Code's tool naming convention.
- **Analyze hook blocking agent** — PostToolUse hook prompt rewritten to never block continuation.

## 0.12.0 (2026-04-08)

### Breaking Changes

- **Recorder rewritten as single-phase** — The old two-phase approach (codegen → replay) is replaced by a single `page.pause()` session running inside Playwright Test. The browser opens once with the Inspector, the user interacts, clicks "Resume" when done, and trace + video are captured automatically. No more replay failures on auth redirects, `getBy*` locator issues, or ghost browser windows. The `recording.ts` codegen script is no longer generated.

### Features

- **Predictable output** — Recorder always produces `trace.zip` + `video.webm` in the output directory. Previous artifacts are cleaned up automatically before each recording.
- **Auth state via `--load-storage`** — Pre-load authentication state so recording starts from a logged-in session.

### Bug fixes

- **Recorder replay broken for getBy\* locators** — Eliminated entirely by removing the replay phase.
- **Recorder missed actions after redirects** — Eliminated by recording the live session directly.
- **Recorder "ghost browser"** — No second browser window; single session only.
- **Duplicate video files** — Hash-named `.webm` files are renamed to `video.webm`; old artifacts are cleaned before recording.

## 0.11.1 (2026-04-07)

### Bug fixes

- **Voiceover volume jump** — Fixed audible volume increase when click sound track ends during voiceover playback. Click sound track is now padded with silence to match voiceover length, and `amix` uses `normalize=0` to prevent automatic gain redistribution.

## 0.11.0 (2026-04-07)

### Features

- **Background music** — New `.backgroundMusic({ path, volume?, ducking?, duckLevel?, duckFadeMs?, fadeOutMs?, loop? })` pipeline stage. Add background music that auto-ducks during voiceover, loops if shorter than video, and fades out at the end. Music covers the full output including intro/outro segments. Ducking can be disabled for fixed-volume mode.

### Bug fixes

- **Click sound desync** — Fixed click sound timing not matching visual click effects. Click events and cursor keyframes now compensate for blank lead-in trim, matching the voiceover/subtitle compensation that was already in place. Previously, click sounds could be up to several seconds late depending on speed configuration.

### Architecture

- New `src/types/background-music.ts` — `BackgroundMusicConfig` interface
- New `src/background-music/defaults.ts` — Default config, `resolveBackgroundMusicConfig()`
- New `src/background-music/music-processor.ts` — Music track generation with loop/trim, ducking via ffmpeg volume expressions, fade-out
- Background music mixing runs as post-processing after intro/outro (covers full video duration)

## 0.10.0 (2026-04-07)

### Features

- **Intro/outro** — New `.intro({ path, fadeDuration? })` and `.outro({ path, fadeDuration? })` pipeline stages. Prepend/append video clips with smooth crossfade transitions (video `xfade` + audio `acrossfade`). Resolution and FPS are auto-normalized to match the main content. Original audio from intro/outro is preserved through the crossfade.
- **recast-studio CLI** — New `recast-studio` binary for recording browser sessions. Launches Playwright Codegen for interaction capture, then replays the generated script with tracing enabled to produce a deterministic `trace.zip`. Usage: `npx recast-studio <url>`.
- **studio-workflow skill** — Claude Code skill that analyzes a recorded trace, generates voiceover scripts, builds SRT subtitles, and runs the full recast pipeline. The AI analysis runs inside the agent — no API SDK dependency.

### Architecture

- New `src/types/intro-outro.ts` — `IntroConfig`, `OutroConfig` interfaces
- New `src/render/intro-outro.ts` — `applyIntroOutro()` with two-pass crossfade, resolution normalization, silent audio generation for videos without audio tracks
- New `src/studio/` — Recording CLI (`cli.ts`, `recorder.ts`, `types.ts`) using Playwright Codegen + replay with tracing
- New `.claude/playwright-recast/skills/studio-workflow/` — Claude Code skill for trace-to-video workflow
- Exported `probeResolution`, `getVideoDuration`, `ffmpeg` from `renderer.ts` for reuse

## 0.9.0 (2026-04-02)

### Features

- **Text highlight** — New `.textHighlight(config?)` pipeline stage renders animated marker overlays on text. Swipe-in animation reveals the highlight left-to-right, then disappears at subtitle boundary. Reads highlight data from `report.json` automatically.
- **`highlight()` helper** — New step helper captures element bounding box (or specific text substring via Range API) and stores it as an annotation. Supports `text` option for highlighting specific substrings inside elements, including input/textarea via mirror measurement.
- **Recording context filtering** — Click effects, cursor overlay, and auto-zoom now filter out actions from setup/background contexts. Only actions after the first recording frame are processed, preventing phantom clicks and incorrect zoom targets.

### Bug fixes

- **ffmpeg concat path doubling** — Fixed path doubling in concat.txt files for voiceover, click sound, and speed segment concatenation. All concat files now use `path.basename()` for relative paths.
- **Speed baseline** — Fixed speed segment baseline to use first recording frame timestamp instead of first recording action. Prevents timing drift when recording starts before user actions.
- **Auto-zoom fill detection** — Fixed auto-zoom not detecting `fill` actions due to 24s timing offset between setup and recording contexts. Auto-zoom now uses recording context baseline for video time calculation.
- **Auto-zoom input fallback** — When fill/type actions lack cursor coordinates (Playwright doesn't record point for programmatic fill), auto-zoom falls back to viewport center.
- **Highlight subtitle clamping** — Highlight end time is clamped to subtitle boundary so overlays don't overflow into the next step.
- **Speed fast-forward threshold** — Segments with TTS duration significantly shorter than original duration now trigger fast-forward, not just segments exceeding the absolute 30s threshold.

### Architecture

- New `src/types/text-highlight.ts` — `TextHighlightConfig`, `HighlightEvent` types
- New `src/text-highlight/defaults.ts` — Default config, `resolveTextHighlightConfig()`
- New `src/text-highlight/highlight-generator.ts` — ffmpeg lavfi marker clip generation with geq-based swipe animation
- Pipeline writes `recast-report.json` instead of overwriting `report.json`

## 0.8.0 (2026-04-01)

### Features

- **Frame interpolation** — New `.interpolate(config)` pipeline stage generates smooth intermediate frames using ffmpeg's `minterpolate` filter. Three modes: `dup` (duplicate), `blend` (crossfade), `mci` (motion-compensated). Configurable target FPS, quality presets, and multi-pass support for progressively smoother results.
- **Scene change detection** — Interpolation uses `scd=fdiff` with threshold 5 to detect scene transitions (e.g., navigation, page changes). At scene boundaries, frames are duplicated instead of blended, preventing ghosting artifacts.
- **Multi-pass interpolation** — `passes` option distributes FPS increase geometrically across multiple passes. Each pass interpolates already-smoothed frames for cleaner output (e.g., 25fps → 39fps → 60fps with `passes: 2`).
- **CLI flags** — `--interpolate`, `--interpolate-fps`, `--interpolate-mode`, `--interpolate-quality`, `--interpolate-passes`.

### Architecture

- New `src/types/interpolate.ts` — `InterpolateConfig`, `InterpolateMode`, `InterpolateQuality` types
- New `src/interpolate/interpolator.ts` — `interpolateVideo()`, `buildMinterpolateFilter()`, `computePassFps()`
- Interpolation runs as Phase 2.5 (after speed processing, before cursor/click/zoom overlays) to operate at source resolution

## 0.7.1 (2026-04-01)

### Features

- **ElevenLabs language code** — New `languageCode` option in `ElevenLabsProviderConfig` forces the TTS language via ISO 639-1 code (e.g. `'cs'` for Czech). Prevents auto-detection errors in multilingual content.
- **Typography-aware subtitle chunking** — Word-boundary splitting no longer breaks after single-character words (prepositions, conjunctions like Czech "v", "s", "k", "a", "i"). Follows standard typographic rules.

### Fixes

- **Cursor/click overlay coordinates with zoom** — Cursor overlay and click effects are now applied before zoom cropping. Previously, overlays used original viewport coordinates on the already-cropped frame, causing misaligned click positions during zoomed segments.

## 0.7.0 (2026-04-01)

### Features

- **Cursor overlay** — New `.cursorOverlay(config)` pipeline stage renders an animated cursor that appears briefly before each click, moves to the click position with ease-out animation, then disappears. Bundled default arrow cursor (30x44 PNG) or custom image via config.
- **Animated zoom with easing** — Replaced the segment-based zoom renderer with a single-pass `zoompan` filter. Zoom transitions now use customizable easing functions instead of linear fades.
- **Easing API** — `AutoZoomConfig` accepts `easing` parameter: built-in presets (`'linear'`, `'ease-in'`, `'ease-out'`, `'ease-in-out'`), cubic-bezier (`{ cubicBezier: [0.42, 0, 0.58, 1] }`), or custom JS functions (`{ fn: t => t * t }`). Default: `'ease-in-out'` (smoothstep).
- **Configurable transition duration** — `AutoZoomConfig.transitionMs` controls zoom in/out transition speed (default: 400ms).
- **Zoom-to-zoom panning** — When two zoom targets are close together, the camera pans smoothly between them instead of returning to 1.0x.
- **Cursor overlay CLI** — `--cursor-overlay` enables with defaults, `--cursor-overlay-config <path>` loads JSON config.

### Architecture

- Cursor overlay uses `movie` + `overlay` with per-click `enable` expressions and ease-out movement via `st()/ld()` temp variables
- Zoom now uses `zoompan` filter with `d=1` (per-frame for video) and `in/fps` as time variable, replacing the old multi-segment crop+concat approach
- New `src/render/easing.ts` — hybrid easing: analytic ffmpeg expressions for built-in presets, pre-sampled piecewise-linear for cubic-bezier/custom functions
- New `src/render/zoom-expression.ts` — zoompan expression builder with segment timeline (transition-in, hold, transition-out, pan)
- New `src/types/easing.ts` — `EasingSpec`, `EasingPreset` types
- New `src/cursor-overlay/` — defaults, trajectory builder, expression builder
- Audio mixing fix: `aresample=44100,aformat` before `amix` to handle mixed sample rate tracks

### Breaking Changes

- Internal zoom rendering changed from segment-based to expression-based. Public API (`autoZoom()` config) is backward-compatible — existing configs work unchanged.

## 0.6.0 (2026-03-31)

### Features

- **Click effect stage** — New `.clickEffect(config)` pipeline stage renders animated ripple highlights at click positions in the output video. Visual ripple uses an expanding circle with configurable color, opacity, radius, and duration. Fades out over the animation period.
- **Click sound** — Optional click sound mixed into the audio track. Bundled default click sound or custom audio file via `sound` config option. Volume adjustable via `soundVolume`.
- **Click filtering** — Filter which clicks to highlight via `filter` callback on `ClickEffectConfig`. Only `click` and `selectOption` actions with cursor coordinates are detected.
- **Speed-aware timing** — Click timestamps are automatically remapped through speed processing so ripples appear at the correct video time.
- **CLI flags** — `--click-effect` enables with defaults, `--click-effect-config <path>` loads full JSON config, `--click-sound <path>` sets custom sound file.

### Architecture

- Click events extracted from parsed trace in executor, stored as `ClickEvent[]` (viewport px + video time ms)
- Ripple clip generated once via ffmpeg lavfi (geq circle + fade=out:alpha=1), overlaid per-click using `movie` + `setpts` + `overlay` filter chain
- Sound track built via silence + click sound concat, mixed with voiceover via `amix`

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
