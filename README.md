# playwright-recast

**Transform Playwright traces into stunning demo videos — automatically.**

[![npm version](https://img.shields.io/npm/v/playwright-recast)](https://www.npmjs.com/package/playwright-recast)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> Your Playwright tests already capture everything — traces, screenshots, network activity, cursor positions. **playwright-recast** turns those artifacts into polished, narrated product videos with a single fluent pipeline.



https://github.com/user-attachments/assets/418d996d-2e18-4ae8-9ccc-3e5161dc7af8




---

## Why?

Recording product demos is painful. Every UI change means re-recording. Manual voiceover and subtitling takes hours. Timing is always off.

**playwright-recast** flips this:** your Playwright tests become your video source.** Write tests once, regenerate polished videos on every deploy.

```typescript
import { Recast, ElevenLabsProvider } from 'playwright-recast'

await Recast
  .from('./test-results/trace.zip')
  .parse()
  .speedUp({ duringIdle: 3.0, duringUserAction: 1.0 })
  .subtitlesFromSrt('./narration.srt')
  .voiceover(ElevenLabsProvider({ voiceId: 'daniel' }))
  .render({ format: 'mp4', resolution: '1080p' })
  .toFile('demo.mp4')
```

**That's it.** Trace in, polished video out.

---

## Features

- **Fluent pipeline API** — Chainable, immutable, lazy-evaluated. Build complex pipelines that read like English.
- **Trace-based processing** — Parses Playwright trace.zip (actions, screenshots, network, cursor positions). No manual recording needed.
- **Smart speed control** — Automatically speeds up idle time, network waits, and navigation while keeping user actions at normal speed.
- **TTS voiceover** — Generate narration with OpenAI TTS or ElevenLabs. Properly timed with silence padding.
- **Subtitle generation** — SRT, WebVTT, and ASS output. Import external SRT or generate from trace BDD step titles.
- **Styled subtitle burn-in** — Configurable font, size, color, background box with opacity, padding, position. Smart punctuation-based chunking for single-line display.
- **playwright-bdd support** — First-class integration with playwright-bdd Gherkin steps. Doc strings become voiceover narration.
- **Click highlighting** — Animated ripple effect at click positions with optional click sound. Configurable color, opacity, radius, duration.
- **Cursor overlay** — Animated cursor appears before each click, moves to the click position with ease-out animation, then disappears. Bundled arrow cursor or custom image.
- **Animated zoom with easing** — Auto-zoom uses customizable easing functions (ease-in-out, ease-out, cubic-bezier, or custom JS functions) with smooth zoom-to-zoom panning.
- **Frame interpolation** — Smooth out choppy browser recordings with ffmpeg minterpolate. Blend, duplicate, or motion-compensated modes with multi-pass support.
- **Step helpers** — `narrate()`, `zoom()`, `pace()` — importable helpers for Playwright step definitions.
- **CLI included** — `npx playwright-recast -i trace.zip -o demo.mp4` — no code needed.
- **Zero lock-in** — Every stage is optional. Use just the trace parser, just the subtitle generator, or the full pipeline.

---

## Quick Start

### Install

```bash
npm install playwright-recast
# or
bun add playwright-recast
```

**System requirement:** `ffmpeg` and `ffprobe` must be on your PATH.

```bash
# macOS
brew install ffmpeg

# Ubuntu
sudo apt install ffmpeg
```

### CLI Usage

```bash
# Basic — trace to video
npx playwright-recast -i ./test-results/trace.zip -o demo.mp4

# With speed processing
npx playwright-recast -i ./traces --speed-idle 4.0 --speed-action 1.0

# With external SRT subtitles
npx playwright-recast -i ./traces --srt narration.srt --burn-subs

# With TTS voiceover (OpenAI)
npx playwright-recast -i ./traces --srt narration.srt --provider openai --voice nova

# With TTS voiceover (ElevenLabs)
npx playwright-recast -i ./traces --srt narration.srt --provider elevenlabs --voice onwK4e9ZLuTAKqWW03F9
```

### Programmatic API

```typescript
import { Recast, OpenAIProvider } from 'playwright-recast'

// Minimal — just trace to video
await Recast.from('./traces').parse().render().toFile('output.mp4')

// Full pipeline
await Recast
  .from('./test-results/')
  .parse()
  .hideSteps(s => s.keyword === 'Given' && s.text?.includes('logged in'))
  .speedUp({
    duringIdle: 4.0,
    duringUserAction: 1.0,
    duringNetworkWait: 2.0,
    minSegmentDuration: 500,
  })
  .subtitlesFromSrt('./narration.srt')
  .voiceover(OpenAIProvider({
    voice: 'nova',
    speed: 1.2,
    instructions: 'Professional product demo narration.',
  }))
  .render({
    format: 'mp4',
    resolution: '1080p',
    fps: 60,
    burnSubtitles: true,
    subtitleStyle: {
      fontSize: 48,
      primaryColor: '#1a1a1a',
      backgroundColor: '#FFFFFF',
      backgroundOpacity: 0.75,
      padding: 20,
      bold: true,
      chunkOptions: { maxCharsPerLine: 55 },
    },
  })
  .toFile('demo.mp4')
```

### playwright-bdd Integration

Use `narrate()` and `pace()` in your BDD step definitions:

```typescript
// steps/fixtures.ts
import { test } from 'playwright-bdd'
import { setupRecast, narrate, pace } from 'playwright-recast'

setupRecast(test)
export { narrate, pace }

// steps/my-steps.ts
import { Given, When, Then } from './fixtures'
import { narrate, pace } from 'playwright-recast'

Given('the user opens the dashboard', async ({ page }, docString?: string) => {
  narrate(docString)
  await page.goto('/dashboard')
  await pace(page, 4000)
})
```

```gherkin
Feature: Dashboard demo

  Scenario: View analytics
    Given the user opens the dashboard
      """
      Let's open the analytics dashboard to see real-time metrics.
      """
    When the user clicks the revenue chart
      """
      Clicking on the revenue chart reveals detailed breakdown.
      """
```

---

## Pipeline Stages

Every stage is optional and composable:

| Stage | Description |
|-------|-------------|
| `.parse()` | Parse Playwright trace.zip into structured data (actions, frames, network, cursor) |
| `.hideSteps(predicate)` | Remove steps from the output (e.g., login, setup) |
| `.speedUp(config)` | Adjust video speed based on activity (idle, action, network) |
| `.subtitles(textFn)` | Generate subtitles from trace actions |
| `.subtitlesFromSrt(path)` | Load subtitles from an external SRT file |
| `.subtitlesFromTrace()` | Auto-generate subtitles from BDD step titles in trace |
| `.textProcessing(config)` | Sanitize subtitle text before TTS (strip quotes, normalize dashes, custom rules) |
| `.autoZoom(config)` | Auto-zoom to user actions with customizable easing transitions |
| `.enrichZoomFromReport(steps)` | Apply zoom coordinates from external report data |
| `.cursorOverlay(config)` | Animated cursor at click positions (appears, moves, disappears) |
| `.clickEffect(config)` | Add visual ripple + optional click sound at click positions |
| `.interpolate(config)` | Frame interpolation for smoother video (ffmpeg minterpolate) |
| `.voiceover(provider)` | Generate TTS audio from subtitle text |
| `.render(config)` | Render final video (format, resolution, fps, styled subtitle burn-in) |
| `.toFile(path)` | Execute pipeline and write output |

---

## Subtitle Styling

Burn styled subtitles into the video with full control over appearance:

```typescript
.render({
  burnSubtitles: true,
  subtitleStyle: {
    fontFamily: 'Arial',          // Any system font
    fontSize: 48,                 // Pixels (relative to 1080p)
    primaryColor: '#1a1a1a',      // Text color (hex)
    backgroundColor: '#FFFFFF',   // Box background (hex)
    backgroundOpacity: 0.75,      // 0.0 transparent — 1.0 opaque
    padding: 20,                  // Box padding in px
    bold: true,
    position: 'bottom',           // 'bottom' or 'top'
    marginVertical: 50,           // Distance from edge
    marginHorizontal: 100,        // Side margins (text wraps within)
    wrapStyle: 'smart',           // 'smart', 'endOfLine', 'none'
    chunkOptions: {               // Split long text into single-line chunks
      maxCharsPerLine: 55,        // Split at punctuation when text exceeds this
      minCharsPerChunk: 15,       // Merge tiny fragments
    },
  },
})
```

**Punctuation-based chunking** splits long subtitle text into shorter single-line entries. Time is distributed proportionally by character count. Splits at sentence boundaries (`. ! ?`) first, then clause boundaries (`, ; :`) if still too long.

Without `subtitleStyle`, `burnSubtitles: true` falls back to default ffmpeg SRT rendering.

---

## Text Processing

Clean subtitle text before sending to TTS providers. Removes typographic characters that cause artifacts in voice synthesis while keeping the original text for visual subtitles.

```typescript
// Built-in sanitization (strips smart quotes, normalizes dashes, etc.)
.textProcessing({ builtins: true })

// Custom regex rules
.textProcessing({
  builtins: true,
  rules: [
    { pattern: '\\bNSS\\b', flags: 'g', replacement: 'Nejvyšší správní soud' },
  ],
})

// Programmatic transform
.textProcessing({
  transform: (text) => text.replace(/\[.*?\]/g, ''),
})
```

**Built-in rules** (when `builtins: true`):
- Remove double quotes: `„` `"` `"` `"` `«` `»` `"`
- Remove single quotes: `'` `'` `‚` `‛` `‹` `›`
- Dashes → comma: `–` `—` → `, `
- Ellipsis: `…` → `...`
- Normalize: NBSP → space, collapse whitespace, trim

Text processing writes to `ttsText` — the voiceover uses cleaned text while burnt-in subtitles and SRT/VTT output keep the original `text`.

**CLI:**
```bash
npx playwright-recast -i ./traces --text-processing --provider openai
npx playwright-recast -i ./traces --text-processing-config ./rules.json --provider elevenlabs
```

---

## TTS Providers

### OpenAI TTS

```typescript
import { OpenAIProvider } from 'playwright-recast/providers/openai'

OpenAIProvider({
  voice: 'nova',          // alloy, echo, fable, onyx, nova, shimmer
  model: 'gpt-4o-mini-tts',
  speed: 1.2,
  instructions: 'Calm, professional demo narration.',
})
```

Requires `OPENAI_API_KEY` environment variable or `apiKey` option.

### ElevenLabs

```typescript
import { ElevenLabsProvider } from 'playwright-recast/providers/elevenlabs'

ElevenLabsProvider({
  voiceId: 'onwK4e9ZLuTAKqWW03F9',  // Daniel
  modelId: 'eleven_multilingual_v2',
  languageCode: 'cs',                // Force Czech (ISO 639-1)
})
```

Requires `ELEVENLABS_API_KEY` environment variable or `apiKey` option.

---

## Zoom

Zoom into specific areas of the video during steps — focus the viewer's attention on the relevant UI element.

### Auto-zoom from trace

Automatically zoom into input elements (fill/type actions) detected from the Playwright trace. Zoom window follows the actual action duration — zooms in when the user starts typing, zooms out when they move on. Smooth fade transitions between zoom states.

```typescript
await Recast
  .from('./traces')
  .parse()
  .subtitlesFromSrt('./narration.srt')
  .autoZoom({
    inputLevel: 1.4,    // zoom level for fill/type actions
    clickLevel: 1.0,    // 1.0 = no zoom on clicks (default)
    centerBias: 0.3,    // blend coordinates toward center (0–1)
  })
  .render({ format: 'mp4' })
  .toFile('demo.mp4')
```

`autoZoom()` finds click/fill/type actions in the trace, extracts their cursor coordinates, and applies crop-and-scale zoom during the matching subtitle's time window.

### Zoom from report data

Apply zoom coordinates from an external source (e.g., a demo report with per-step zoom data):

```typescript
const reportSteps = [
  { zoom: null },                            // Step 1: no zoom
  { zoom: { x: 0.5, y: 0.8, level: 1.4 } }, // Step 2: zoom to input area
  { zoom: null },                            // Step 3: no zoom
  { zoom: { x: 0.78, y: 0.45, level: 1.3 }}, // Step 4: zoom to sidebar
]

await Recast
  .from('./traces')
  .parse()
  .subtitlesFromSrt('./narration.srt')
  .enrichZoomFromReport(reportSteps)
  .render({ format: 'mp4' })
  .toFile('demo.mp4')
```

### Zoom from step helpers

Capture zoom coordinates during Playwright test execution using the `zoom()` helper:

```typescript
import { zoom } from 'playwright-recast'

When('the user opens the sidebar', async ({ page }) => {
  const sidebar = page.locator('.sidebar-panel')
  await zoom(sidebar, 1.3) // Record zoom target for this step
  await sidebar.click()
})
```

The helper captures the element's bounding box as a Playwright annotation. Use `enrichZoomFromReport()` to apply these coordinates during video generation.

### Zoom coordinates

All zoom coordinates use viewport-relative fractions (0.0–1.0):

| Field | Description | Default |
|-------|-------------|---------|
| `x` | Center X (0 = left, 1 = right) | 0.5 |
| `y` | Center Y (0 = top, 1 = bottom) | 0.5 |
| `level` | Zoom level (1.0 = no zoom, 2.0 = 2x) | 1.0 |

The renderer applies zoom by cropping the video to `(width/level × height/level)` centered at `(x, y)`, then scaling back to the output resolution.

---

## Click Effect

Highlight click actions with animated ripple effects and optional click sounds.

```typescript
await Recast
  .from('./traces')
  .parse()
  .clickEffect({
    color: '#3B82F6',    // Ripple color (hex, default: blue)
    opacity: 0.5,        // Ripple opacity 0.0–1.0
    radius: 30,          // Max radius in px (relative to 1080p)
    duration: 400,       // Animation duration in ms
    sound: true,         // true = bundled default, or path to custom audio
    soundVolume: 0.8,    // Sound volume 0.0–1.0
  })
  .render({ format: 'mp4' })
  .toFile('demo.mp4')
```

The click effect stage automatically detects `click` and `selectOption` actions from the Playwright trace. Timestamps are remapped through speed processing so ripples appear at the correct video time.

**Filtering clicks:**

```typescript
.clickEffect({
  filter: (action) => action.method === 'click', // Only clicks, not selectOption
})
```

**CLI:**
```bash
npx playwright-recast -i ./traces --click-effect
npx playwright-recast -i ./traces --click-effect --click-sound click.mp3
npx playwright-recast -i ./traces --click-effect-config config.json
```

---

## Frame Interpolation

Generate smooth intermediate frames from choppy browser recordings using ffmpeg's `minterpolate` filter.

```typescript
await Recast
  .from('./traces')
  .parse()
  .interpolate({
    fps: 60,              // Target FPS (default: 60)
    mode: 'blend',        // 'dup' | 'blend' | 'mci' (default: 'mci')
    quality: 'balanced',  // 'fast' | 'balanced' | 'quality' (default: 'balanced')
    passes: 1,            // Multi-pass for smoother results (default: 1)
  })
  .render({ format: 'mp4' })
  .toFile('demo.mp4')
```

### Modes

| Mode | Speed | Quality | Description |
|------|-------|---------|-------------|
| `dup` | Instant | None | Duplicate frames to reach target FPS |
| `blend` | Fast | Good | Linear crossfade between frames |
| `mci` | Slow | Best | Motion-compensated interpolation (CPU-intensive, especially at 4K) |

### Multi-pass

With `passes: 2`, FPS is distributed geometrically across passes (e.g., 25fps -> 39fps -> 60fps). Each pass interpolates already-smoothed frames for a cleaner result.

**CLI:**
```bash
npx playwright-recast -i ./traces --interpolate
npx playwright-recast -i ./traces --interpolate --interpolate-fps 30
npx playwright-recast -i ./traces --interpolate --interpolate-mode blend --interpolate-passes 2
```

---

## Speed Processing

The speed processor classifies every moment of the trace:

| Activity | Default Speed | Description |
|----------|---------------|-------------|
| **User Action** | 1.0x | Clicks, fills, keyboard input — real-time |
| **Navigation** | 2.0x | Page loads, redirects — slightly faster |
| **Network Wait** | 2.0x | API calls in flight — compress wait time |
| **Idle** | 4.0x | Nothing happening — skip quickly |

```typescript
.speedUp({
  duringIdle: 4.0,
  duringUserAction: 1.0,
  duringNetworkWait: 2.0,
  duringNavigation: 2.0,
  minSegmentDuration: 500,  // Avoid jarring speed changes
  maxSpeed: 8.0,            // Safety cap
})
```

---

## Architecture

```
Trace.zip → ParsedTrace → FilteredTrace → SpeedMappedTrace → SubtitledTrace → VoiceoveredTrace → MP4
               ↑               ↑                ↑                  ↑       ↑          ↑              ↑
            parse()       hideSteps()        speedUp()         subtitles() textProcessing() voiceover()  render()
```

The pipeline is **lazy** — calling chain methods builds a pipeline description. Nothing executes until `.toFile()` or `.toBuffer()` is called.

Each pipeline instance is **immutable** — every method returns a new pipeline, so you can branch:

```typescript
const base = Recast.from('./traces').parse().speedUp({ duringIdle: 3.0 })

// Branch A: with voiceover
await base.subtitlesFromSrt('./en.srt').voiceover(openai).render().toFile('demo-en.mp4')

// Branch B: subtitles only
await base.subtitlesFromSrt('./cs.srt').render({ burnSubtitles: true }).toFile('demo-cs.mp4')
```

---

## Contributing

Contributions welcome! Please check the [issues](https://github.com/ThePatriczek/playwright-recast/issues) for open tasks.

```bash
git clone https://github.com/ThePatriczek/playwright-recast.git
cd playwright-recast
npm install
npm test
```

---

## License

MIT
