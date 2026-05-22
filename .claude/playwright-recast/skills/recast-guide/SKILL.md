---
name: recast-guide
description: Guide for using playwright-recast to convert Playwright traces into demo videos. Use when the user asks to create product demos, generate videos from tests, add voiceover to traces, or process Playwright recordings.
---

# playwright-recast — Agent Guide

You help users convert Playwright test traces into polished demo videos using the `playwright-recast` library.

## When to Use

- User asks to create a product demo video from tests
- User wants to add voiceover/narration to a Playwright recording
- User wants to process a Playwright trace into a video
- User mentions "demo video", "product video", "trace to video", "TTS voiceover"
- User has a `trace.zip` or `test-results/` directory they want to turn into a video

## Prerequisites

- `ffmpeg` and `ffprobe` on PATH
- Playwright trace.zip (from `trace: 'on'` in playwright.config.ts)
- Optional: video recording (from `recordVideo` in browser context)
- Optional: TTS API key (`OPENAI_API_KEY` or `ELEVENLABS_API_KEY`)

## Core API — Fluent Pipeline

playwright-recast uses an immutable, fluent pipeline. Every method returns a new pipeline. Nothing executes until `.toFile()`.

```typescript
import { Recast, OpenAIProvider } from 'playwright-recast'

await Recast
  .from('./test-results/trace.zip')   // Input: trace dir or zip
  .parse()                             // Parse trace into structured data
  .hideSteps(s => s.hidden)            // Remove setup steps (login, etc.)
  .speedUp({                           // Smart speed control
    duringIdle: 3.0,                   // Fast-forward idle time
    duringUserAction: 1.0,             // Keep actions real-time
    duringNetworkWait: 2.0,            // Compress network waits
  })
  .subtitlesFromSrt('./narration.srt') // Load subtitle text
  .voiceover(OpenAIProvider({          // Generate TTS audio
    voice: 'nova',
    speed: 1.2,
  }))
  .render({                            // Render final video
    format: 'mp4',
    resolution: '1080p',
  })
  .toFile('demo.mp4')                  // Execute and save
```

## CLI

```bash
# Basic
npx playwright-recast -i ./test-results -o demo.mp4

# With TTS voiceover
npx playwright-recast -i ./traces --srt narration.srt --provider openai --voice nova

# With speed processing
npx playwright-recast -i trace.zip --speed-idle 4 --speed-action 1

# Burn subtitles into video
npx playwright-recast -i ./traces --srt narration.srt --burn-subs
```

## Pipeline Stages

| Method | Purpose |
|--------|---------|
| `.parse()` | Parse trace.zip into actions, frames, network, cursor data |
| `.hideSteps(fn)` | Remove steps matching predicate (login, setup) |
| `.speedUp(config)` | Adjust speed by activity type or explicit segments |
| `.subtitles(textFn)` | Generate subtitles from trace actions |
| `.subtitlesFromSrt(path)` | Load external SRT file |
| `.subtitlesFromTrace()` | Auto-generate subtitles/highlights/zoom from `narrate()`/`highlight()`/`zoom()` marker steps; falls back to BDD step titles when no `narrate()` is present |
| `.textProcessing(config)` | Sanitize subtitle text for TTS (strip quotes, normalize dashes, custom rules) |
| `.autoZoom(config)` | Auto-zoom to user interaction targets from trace |
| `.enrichZoomFromReport(steps)` | Apply zoom coordinates from external report data (legacy — prefer the `zoom()` helper which writes directly into the trace) |
| `.clickEffect(config)` | Visual ripple + optional click sound at click positions |
| `.voiceover(provider)` | Generate TTS from subtitle text |
| `.render(config)` | Configure output format/resolution/fps/subtitle styling |
| `.toFile(path)` | Execute pipeline and save output |

## Text Processing

Sanitize subtitle text before TTS. Writes to `ttsText` field — voiceover uses cleaned text, burnt-in subtitles keep original.

```typescript
// Built-in sanitization (smart quotes, dashes, ellipsis, whitespace)
.textProcessing({ builtins: true })

// Custom regex rules + built-ins
.textProcessing({
  builtins: true,
  rules: [{ pattern: '\\bNSS\\b', flags: 'g', replacement: 'Nejvyšší správní soud' }],
})

// Programmatic transform
.textProcessing({ transform: (text) => text.replace(/\[.*?\]/g, '') })
```

**CLI:** `--text-processing` for built-ins, `--text-processing-config <path>` for JSON rules file.

**Standalone:** `import { processText } from 'playwright-recast'` for use outside the pipeline.

## TTS Providers

**OpenAI TTS** (requires `OPENAI_API_KEY`):
```typescript
import { OpenAIProvider } from 'playwright-recast/providers/openai'
OpenAIProvider({ voice: 'nova', speed: 1.2, instructions: 'Professional tone.' })
```

**ElevenLabs** (requires `ELEVENLABS_API_KEY`):
```typescript
import { ElevenLabsProvider } from 'playwright-recast/providers/elevenlabs'
ElevenLabsProvider({ voiceId: 'onwK4e9ZLuTAKqWW03F9', modelId: 'eleven_multilingual_v2' })
```

## playwright-bdd Integration

Step helpers for BDD test definitions. Each helper (`narrate`, `highlight`, `zoom`) writes a marker-prefixed `test.step()` directly into the trace zip — `subtitlesFromTrace()` picks them all up automatically. No separate `report.json` or extra pipeline calls required.

```typescript
import { setupRecast, narrate, highlight, zoom, pace } from 'playwright-recast'

// In fixtures.ts — initialize once:
setupRecast(test)

// In step definitions:
Given('the user opens dashboard', async ({ page }, docString?: string) => {
  await narrate(docString)        // Records narration into the trace
  await page.goto('/dashboard')
  await pace(page, 4000)          // Pause for voiceover timing
})

When('the user reviews KPI', async ({ page }, docString?: string) => {
  await narrate(docString, { autoWait: true }) // pad test by estimated speak time
  await highlight(page.locator('h2'), { text: 'Revenue' })
  await zoom(page.locator('.kpi-card'), 1.3)
})
```

**Voiceover-driven freezes:** when TTS audio is longer than its visual window the renderer holds the current frame until the audio finishes — overlays freeze with it, click sounds shift to match. No config required.

Feature file with voiceover text:
```gherkin
Scenario: View analytics
  Given the user opens dashboard
    """
    Let's open the dashboard to see real-time metrics.
    """
```

## Zoom

Zoom into specific UI areas during steps. Three approaches:

**Auto-zoom from trace** — detects click/fill targets automatically:
```typescript
.autoZoom({ actionLevel: 1.5 })
```

**From report data** — manual viewport-relative coordinates per subtitle:
```typescript
.enrichZoomFromReport([
  { zoom: null },                            // no zoom
  { zoom: { x: 0.5, y: 0.8, level: 1.4 } }, // zoom to input area
])
```

**From step helpers** — capture element bounding box during the test (writes marker into the trace; picked up automatically by `.subtitlesFromTrace()`):
```typescript
import { zoom } from 'playwright-recast'
await zoom(page.locator('.sidebar'), 1.3)
```

Zoom starts at the `zoom()` call site (not at the parent narration's start) and runs until the end of the surrounding subtitle.

Coordinates: `x` and `y` are viewport fractions (0.0–1.0), `level` is zoom factor (1.0 = none, 2.0 = 2x).

## Click Effect

Highlight clicks with animated ripple and optional sound:

```typescript
.clickEffect({
  color: '#3B82F6',    // Ripple color (hex, default: blue)
  opacity: 0.5,        // 0.0–1.0 (default: 0.5)
  radius: 30,          // Max radius px at 1080p (default: 30)
  duration: 400,       // Animation ms (default: 400)
  sound: true,         // true = bundled default, or path to custom audio
  soundVolume: 0.8,    // 0.0–1.0 (default: 0.8)
  filter: (a) => a.method === 'click', // Optional: filter which clicks
})
```

Detects `click` and `selectOption` actions with cursor coordinates. Timestamps auto-remapped through speed processing.

**CLI:** `--click-effect`, `--click-effect-config <path>`, `--click-sound <path>`.

## Styled Subtitle Burn-in

Burn configurable subtitles into the video via ASS format:

```typescript
.render({
  burnSubtitles: true,
  fps: 60,
  subtitleStyle: {
    fontSize: 48,                 // Pixels relative to 1080p
    primaryColor: '#1a1a1a',      // Text color
    backgroundColor: '#FFFFFF',   // Box background
    backgroundOpacity: 0.75,      // 0.0–1.0
    padding: 20,
    bold: true,
    position: 'bottom',
    marginVertical: 50,
    marginHorizontal: 100,
    chunkOptions: { maxCharsPerLine: 55 }, // Split long text
  },
})
```

Without `subtitleStyle`, `burnSubtitles: true` uses default ffmpeg SRT rendering.

## Voiceover-Driven Speed

For perfect audio-video sync, pre-generate TTS, measure real durations, and compute per-step video speed:

```typescript
.speedUp({
  segments: [                     // Explicit speed segments
    { startMs: 0, endMs: 7000, speed: 1.5 },
    { startMs: 7000, endMs: 17000, speed: 1.0 },
    { startMs: 17000, endMs: 430000, speed: 60 }, // fast-forward AI processing
  ],
})
```

## Common Patterns

### Generate video from existing test run
```bash
npx playwright test --trace on
npx playwright-recast -i ./test-results -o demo.mp4 --srt narration.srt --provider openai --voice nova
```

### Hide login/setup from video
```typescript
.hideSteps(s => s.keyword === 'Given' && s.text?.includes('logged in'))
```

### Multi-language versions from one trace
```typescript
const base = Recast.from('./traces').parse().speedUp({ duringIdle: 3.0 })

await base.subtitlesFromSrt('./en.srt').voiceover(openai).render().toFile('demo-en.mp4')
await base.subtitlesFromSrt('./cs.srt').voiceover(openai).render().toFile('demo-cs.mp4')
```
