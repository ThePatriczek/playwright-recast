# Changelog

## 0.19.0 (2026-05-27)

### Features

- **Explicit click markers** ([#15](https://github.com/ThePatriczek/playwright-recast/pull/15)) — Added `click()` and `markClick()` helpers. Marker-driven clicks suppress matching auto-detected clicks, render at the marked point, and can play a held cursor approach over the painted target via `cursorOverlay({ approachMs })`.
- **`waitForNarration()` narration boundaries** ([#15](https://github.com/ThePatriczek/playwright-recast/pull/15)) — Added a trace marker helper that closes the previous `narrate()` line's subtitle window. With `.voiceover()`, the renderer freezes at that boundary until the line's audio finishes, so tests can run at full speed without `autoWait`/`pace()` just to fit speech.
- **Audio-synced approach holds** ([#15](https://github.com/ThePatriczek/playwright-recast/pull/15)) — Click approach holds now extend audio and subtitles in lockstep with the video. Cursor/click overlays are rendered on the freeze-extended timeline so visuals, click sounds, narration, and subtitles stay aligned.

### Bug fixes

- **Fast-trace narrations are no longer dropped** — Tiny or zero-width `narrate() -> waitForNarration()` windows are kept through subtitle assembly so voiceover can size them from real audio. Degenerate subtitles that remain zero-duration without voiceover are filtered before burn/embed output.
- **Click marker reconciliation is deterministic** — Multiple markers competing for the same auto-detected click now choose the nearest eligible marker and drop competing duplicates, avoiding duplicate ripples/keyframes.
- **Setup/background click markers are ignored for approach holds** — Voiceover approach holds now use the same recording-context filter as click effects and cursor overlays, preventing setup/background markers from adding unintended freezes or silence.
- **Marker helpers degrade safely without `setupRecast()`** — `markClick()` no-ops before reading locator geometry, and `click()` falls back to plain `locator.click(options)` without settle/marker overhead.

### Docs

- Updated README, website helper/pipeline docs, API reference, playwright-bdd integration docs, and the recast-guide skill for `click()`, `markClick()`, `waitForNarration()`, `clickSettleMs`, `approachMs`, and voiceover-driven pacing.

### Internal

- Test suite: **462 passed** (+4 — no-setup click helper fallback, recording-context click marker parsing, nearest-marker reconciliation, and exact-boundary approach-hold sync).

## 0.18.1 (2026-05-25)

### Bug fixes

- **`hideSteps()` leaked hidden-step clicks, cursor, and content into the rendered video** ([#13](https://github.com/ThePatriczek/playwright-recast/pull/13)) — When a parent step (e.g. `test.step('login', …)`) was hidden, its child click actions survived filtering, so `clickEffect`, `cursorOverlay`, and the renderer still rendered them — clicks piled up at `videoTimeMs=0`, and cursor motion from inside the hidden step remained visible. `processSpeed`'s `minSegmentDuration` merge could also bridge across the hidden gap, pulling the cut content back into output segments. Fixed across four modules: `filterSteps` now drops child actions whose `startTime` falls inside a hidden range; the executor feeds filtered actions to click/cursor stages and re-runs `processSpeed` when `hideSteps` is called after `speedUp`; `processSpeed` only merges short segments when they are adjacent; `buildTimeRemap` snaps gap times forward to the next segment's `outputStart`.

### Docs

- **Qwen venv renamed to `playwright-recast`** ([#12](https://github.com/ThePatriczek/playwright-recast/pull/12)) — The recommended shared venv is now `~/.venvs/playwright-recast` (was `~/.venvs/qwen-tts`). Dropped uv/conda/per-project alternatives to keep setup instructions focused. Thanks to [@Andy2003](https://github.com/Andy2003).

### Internal

- Test suite: **413 passed** (+3 — step-filter child-action test, speed-processor gap-merge test, time-remap gap-snap test).

## 0.18.0 (2026-05-22)

### Features

- **Disk cache for `ElevenLabsProvider` / `OpenAIProvider` / `PollyProvider`** ([#11](https://github.com/ThePatriczek/playwright-recast/pull/11)) — Set `cacheDir` on any built-in provider and re-renders skip the API call for `(text, voice, model, language, settings)` tuples that have already been synthesized. Cache key is a SHA-256 over all audio-affecting inputs, so changing the voice / model / settings invalidates the entry. Saves API spend on iterative edits (re-render after subtitle tweaks → only the changed lines hit the API). Omit `cacheDir` to disable disk caching; intra-batch dedup (same narration reused twice in one render) still applies automatically.
- **`synthesizeWithCache()` helper + `planBatch` primitives** — Exposed from `src/voiceover/providers/util/audio-cache.ts` for custom-provider authors. Wrap your single-text synthesis function and get cache + dedup for free with one call.
- **`provider.isAvailable()` is now a meaningful pre-flight check** ([#10](https://github.com/ThePatriczek/playwright-recast/pull/10)) — `generateVoiceover` awaits `isAvailable()` before `synthesize()` and throws an actionable error when the provider is not configured. Per-provider checks: OpenAI / ElevenLabs verify the API key is set AND the peer dependency resolves; Polly verifies the AWS SDK peer dependency resolves; Qwen verifies the configured Python binary spawns AND the sidecar script exists. Misconfiguration now fails fast at the start of the render rather than mid-pipeline.

### Breaking changes

- **`TtsProvider.estimateDurationMs` removed** ([#10](https://github.com/ThePatriczek/playwright-recast/pull/10)) — The method was never called by the library. Custom provider implementations should drop the method; bundled providers (OpenAI / ElevenLabs / Polly / Qwen) have all been updated.

### Internal

- Refactored bundled providers (ElevenLabs / OpenAI / Polly) to share `synthesizeWithCache()` instead of hand-rolled `Promise.all` + buffer writes. Per-provider boilerplate dropped to a single `generateOne(text)` function. Thanks to [@Andy2003](https://github.com/Andy2003) for the original cache pattern in `QwenTtsProvider`.
- Test suite: **410 passed** (+15 — 11 audio-cache helper tests + 4 per-provider cache tests).

## 0.17.0 (2026-05-22)

### Features

- **`QwenTtsProvider`** — Local TTS via Alibaba's Qwen3-TTS family with clone and design modes. Spawns a Python sidecar; opt-in disk caching for both synthesized audio (MP3) and the design reference WAV. See README for setup.

### Breaking changes

- **`TtsProvider.synthesize` is now batch-first** — Signature changes from `synthesize(text: string, options?) => Promise<AudioSegment>` to `synthesize(texts: string[], options?) => Promise<AudioSegment[]>`. The provider receives the full subtitle text array and returns one segment per input, in order. Built-in providers (OpenAI, ElevenLabs, Polly) get free concurrency from internal `Promise.all` fan-out — no caller change required. Custom-provider authors must update their `synthesize` to accept an array.
- **`AudioSegment.data` is replaced by `AudioSegment.path`** — Synthesized audio is now written to a file on disk and the segment carries the path instead of an in-memory `Buffer`. The new `TtsOptions.workDir` field tells the provider where to write outputs (caller — the pipeline — owns cleanup). Custom-provider authors must write their audio to disk and return the path.

### Migration

If you have a custom `TtsProvider`, wrap your existing per-text logic:

```ts
synthesize(texts: string[], opts) {
  const dir = opts?.workDir ?? os.tmpdir()
  return Promise.all(texts.map(async (text) => {
    const buf = await mySingleTextSynthesis(text)
    const p = path.join(dir, `mine-${crypto.randomUUID()}.mp3`)
    await fs.promises.writeFile(p, buf)
    return { path: p, durationMs: 0, format: { sampleRate: 24000, channels: 1, codec: 'mp3' } }
  }))
}
```

## 0.16.0 (2026-05-22)

### Features

- **Self-contained `narrate()` / `highlight()` / `zoom()` helpers** ([#8](https://github.com/ThePatriczek/playwright-recast/pull/8)) — All three helpers now write marker-prefixed `test.step()` events directly into the Playwright trace zip. `subtitlesFromTrace()` recovers narration spans, highlight overlays, and per-subtitle zoom from the recorded marker steps — no `report.json` or extra pipeline calls (`.textHighlight()` / `.enrichZoomFromReport()`) required. The legacy pipeline stages remain available for non-Playwright highlight sources. Thanks to [@Andy2003](https://github.com/Andy2003).
- **Voiceover-driven freezes** — When a narration's TTS audio is longer than its visual window, the renderer now holds the current frame until the audio finishes. Overlays freeze with the frame and click sounds shift to match — audio-perfect sync without hand-tuning `pace()` calls.
- **`narrate({ autoWait })`** — Pads the test by an estimated speaking time using a character-based heuristic (`NARRATE_DEFAULT_CPS = 14`). Accepts `true`, an explicit millisecond count, or `{ charactersPerSecond, minMs, maxMs }`. Useful when running without TTS so the recorded video has natural visual time for each line.
- **`render({ embedSubtitles })`** — Muxes a soft (toggleable) subtitle track into the container: `mov_text` for mp4, `webvtt` for webm. Accepts `true` for defaults or `{ language, title, default }` to customize. Can be combined with `burnSubtitles`.

### Behavior changes

- **`narrate()` is now async** — Returns `Promise<void>` so the trace marker `test.step()` can be awaited. Existing call sites that don't `await` continue to work at runtime — annotations are pushed synchronously before the marker step is scheduled, so the legacy `report.json` flow is unaffected. Add `await` to gain ordering guarantees for `subtitlesFromTrace()`.
- **Zoom marker start time** — Zoom now starts at the `zoom()` call site (in-window) rather than at the parent narration's start, so the camera kicks in only once the target is visible. The same shifts that move `subtitle.startMs` (blank-trim, voiceover `timeShift`) now also move `zoom.startMs` / `zoom.endMs`.

### Bug fixes

- **`narrate()` preserves the flat annotation contract for empty text** — `narrate(undefined, { hidden: true })` and `narrate('')` calls now reliably push both `voiceover` and `voiceover-hidden` annotations onto `testInfo`, matching the pre-0.16 behavior. External reporters that map annotations to BDD steps by sequential index (the legacy `report.json` contract) continue to work without changes. Only the trace marker step is skipped for empty text, since an empty marker carries no useful payload.

### Continuous integration

- **PR test workflow** — Added `.github/workflows/ci.yml` running `tsc --noEmit` and `vitest run` on Node 22 for every pull request and push to `main`. ffmpeg is installed in the job so the render/voiceover suites execute end-to-end.

## 0.15.2 (2026-05-15)

### Bug fixes

- **Standalone trace.zip rendered with no source video** ([#6](https://github.com/ThePatriczek/playwright-recast/issues/6)) — Running `playwright-recast --input <trace>.zip` without a sibling `.webm` (e.g. a trace downloaded from the trace viewer, or a test run without `recordVideo`) failed deep in the renderer with the unhelpful message `Source video not found: undefined`. The renderer previously required a sibling `.webm` recorded by Playwright's `recordVideo` option and never consulted the screencast JPEG frames stored inside the trace zip itself. Pipeline now falls back to assembling a CFR 25fps `.mp4` from the trace's screencast frames (recording-page only, via ffmpeg's concat demuxer with per-frame durations) when no `.webm` is found, so `npx playwright-recast --input foo.trace.zip` works out of the box. If neither a `.webm` nor screencast frames are available, the executor fails fast with an actionable error pointing at the Playwright `video: 'on'` / `--trace=on` knobs. A sibling `.webm` is still preferred (higher native frame rate); the fallback exists so standalone traces aren't a dead end. Reported by [@odiszapc](https://github.com/odiszapc).

## 0.15.1 (2026-05-12)

### Bug fixes

- **Green color cast on output with ffmpeg 8.x** ([#4](https://github.com/ThePatriczek/playwright-recast/issues/4)) — Cursor, click-ripple, and text-highlight overlays used `overlay=...:format=auto`. With ffmpeg 8.x the overlay filter's `format=auto` heuristic selects `yuva444p` when the secondary input is RGBA, so the subsequent encode to `yuv420p` mixed the YUV planes and produced a green-tinted output (a sampled white pixel returned `RGB(127,252,126)` instead of `RGB(253,255,255)`). Pinned `format=yuv420` explicitly on all four overlay filter calls in `src/render/renderer.ts`. Output is clean white on ffmpeg 7.x and 8.x. Thanks to [@maciejdzierzek](https://github.com/maciejdzierzek) for the precise repro and root-cause analysis.

## 0.15.0 (2026-04-15)

### Breaking changes

- **ElevenLabs provider config fields renamed** — `ElevenLabsProviderConfig.voiceId` → `voice`, `modelId` → `model`. Migrate: `ElevenLabsProvider({ voiceId: 'abc', modelId: 'xyz' })` → `ElevenLabsProvider({ voice: 'abc', model: 'xyz' })`.

### Features

- **Unified TTS provider config** — All three providers (ElevenLabs, OpenAI, Polly) now share the same common field names (`voice`, `model`, `languageCode`) and consistently merge factory-config defaults with per-call `TtsOptions`. Provider-specific knobs (ElevenLabs `voiceSettings`, OpenAI `instructions`, Polly `engine`/`textType`) remain in the provider's own config.
- **ElevenLabs `voiceSettings`** — Optional `{ stability, similarityBoost, style, useSpeakerBoost }` can be passed in the factory config. Recommended for consistent loudness — raise `stability` to reduce per-segment volume drift on `eleven_multilingual_v2`.
- **Loudness normalization in `.voiceover(...)`** — New `VoiceoverOptions.normalize` runs each synthesized segment through a two-pass EBU R128 `loudnorm` pass (default `-16 LUFS` / `-1 dBFS TP` / `11 LU`, linear mode) before concat. Fixes large per-segment loudness drift common with ElevenLabs multilingual voices + non-English languages (e.g. czech).

  ```ts
  .voiceover(ElevenLabsProvider({ voice: 'abc' }), { normalize: true })
  .voiceover(provider, { normalize: { targetLufs: -18, truePeakDb: -1.5 } })
  ```

- **`normalizeLoudness(input, output, config?)`** exported from the public API for standalone use outside the pipeline.

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
