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
- **Subtitle generation** — SRT and WebVTT output. Import external SRT or generate from trace BDD step titles.
- **playwright-bdd support** — First-class integration with playwright-bdd Gherkin steps. Doc strings become voiceover narration.
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
  .render({ format: 'mp4', resolution: '1080p', burnSubtitles: true })
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
| `.voiceover(provider)` | Generate TTS audio from subtitle text |
| `.render(config)` | Render final video (format, resolution, burn subtitles) |
| `.toFile(path)` | Execute pipeline and write output |

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
})
```

Requires `ELEVENLABS_API_KEY` environment variable or `apiKey` option.

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
               ↑               ↑                ↑                  ↑                 ↑              ↑
            parse()       hideSteps()        speedUp()         subtitles()       voiceover()     render()
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

## Roadmap

- [ ] **Burned-in subtitles** — Render styled subtitles directly into the video with customizable font, size, color, and position
- [ ] **Smooth zoom transitions** — Animated crop-and-zoom on elements during specific steps
- [ ] **Edge TTS provider** — Free TTS without API key using Microsoft Edge's online voices
- [ ] **Playwright Reporter plugin** — Auto-generate demo videos as part of your test run
- [ ] **Multi-language support** — Generate video variants from the same trace with different SRT/voiceover per language
- [ ] **Intro/outro cards** — Configurable title cards, branding overlays, and end screens
- [ ] **Background music** — Mix ambient music track under voiceover with auto-ducking

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
