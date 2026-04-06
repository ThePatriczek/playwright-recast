# recast-studio — Non-Dev Demo Video Tool

**Date:** 2026-04-06
**Status:** Approved
**Scope:** New `recast-studio` CLI within the playwright-recast package

## Problem

playwright-recast requires developer skills (TypeScript, Playwright tests, CLI). Product managers, marketers, and support staff at AGRP need to create product demo videos without writing code.

## Solution

A CLI wrapper (`recast-studio`) that lets non-technical users record a browser session, have AI generate voiceover scripts, and produce a polished demo video — all in one command.

## User Flow

```
$ npx recast-studio https://app.codexis.cz

🎬  Opening browser... Navigate and interact.
    Close the browser when done.

✅  Session recorded (38s, 9 actions)

🤖  Analyzing with Claude...
    → 6 meaningful steps (3 hidden as setup)
    → Voiceover generated (Czech, marketing tone)

🎥  Running recast pipeline...
    ✔ Speed processing
    ✔ Voiceover (ElevenLabs)
    ✔ Click effects + cursor + auto-zoom
    ✔ Rendering 4K

✅  demo.mp4 (8.2 MB)
```

No code, no config files, no Playwright knowledge required.

## Architecture — 3 Phases

### Phase 1: Record (`src/studio/recorder.ts`)

Opens a real Chromium browser via Playwright API (not codegen — no inspector panel, cleaner UX for non-devs).

```typescript
const browser = await chromium.launch({ headless: false })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: tmpDir, size: { width: 1920, height: 1080 } },
})
await context.tracing.start({ screenshots: true, snapshots: true })
const page = await context.newPage()
await page.goto(url)

// User interacts freely...
// On browser close event:
await context.tracing.stop({ path: path.join(outputDir, 'trace.zip') })
```

**Output:** `trace.zip` + `video.webm` in a temp directory.

**Options passed through:**
- `--viewport <WxH>` — browser viewport size (default: 1920x1080)
- `--load-storage <path>` — pre-load auth cookies/localStorage (from `playwright codegen --save-storage`)
- `--ignore-https-errors` — for internal dev/staging environments

**Browser close detection:** Listen for `browser.on('disconnected')` event. When the user closes the browser window, the recording stops automatically.

### Phase 2: AI Analyze (`src/studio/analyzer.ts`)

Parses the recorded trace using the existing `parseTrace()` function, then sends the action list to Claude API for analysis.

**Input to Claude:** Structured list of trace actions:
```json
[
  { "index": 0, "method": "goto", "url": "https://app.codexis.cz", "timestamp": 0 },
  { "index": 1, "method": "click", "selector": "button:has-text('Přihlásit')", "timestamp": 2340 },
  { "index": 2, "method": "fill", "selector": "#username", "value": "jana@...", "timestamp": 3100 },
  { "index": 3, "method": "fill", "selector": "#password", "value": "***", "timestamp": 4200 },
  { "index": 4, "method": "click", "selector": "button:has-text('Přihlásit se')", "timestamp": 5000 },
  { "index": 5, "method": "click", "selector": ".search-input", "timestamp": 8500 },
  { "index": 6, "method": "fill", "selector": ".search-input", "value": "pracovní právo", "timestamp": 9200 },
  { "index": 7, "method": "click", "selector": ".result-item >> nth=0", "timestamp": 14000 },
  { "index": 8, "method": "click", "selector": "button:has-text('Stáhnout')", "timestamp": 18000 }
]
```

**Claude system prompt** (`src/studio/prompts.ts`):
- Role: product demo video script writer
- Task: analyze raw browser actions, group into logical steps, identify setup/noise to hide, write marketing voiceover for each visible step
- Language: configurable (default: Czech)
- Tone: professional, benefit-focused, concise
- Output format: strict JSON schema

**Output from Claude:**
```json
{
  "title": "Vyhledání a stažení dokumentu v Codexis",
  "steps": [
    { "actionIndices": [0], "hidden": true, "voiceover": null },
    { "actionIndices": [1, 2, 3, 4], "hidden": true, "voiceover": null },
    { "actionIndices": [5, 6], "hidden": false, "voiceover": "Do vyhledávače zadáme klíčový pojem z oblasti pracovního práva." },
    { "actionIndices": [7], "hidden": false, "voiceover": "Z výsledků vybereme nejrelevantnější dokument." },
    { "actionIndices": [8], "hidden": false, "voiceover": "Jedním kliknutím dokument stáhneme pro offline práci." }
  ]
}
```

**Post-processing:**
1. Convert Claude's output to SRT file (map actionIndices to trace timestamps for timing)
2. Build a `hideSteps` predicate from hidden action indices
3. Sanitize — if Claude returns malformed JSON, retry once with error context

### Phase 3: Recast Pipeline

Standard pipeline orchestration — no new pipeline code needed:

```typescript
let pipeline = Recast.from(traceDir)
  .parse()
  .hideSteps(hiddenPredicate)       // from AI analysis
  .speedUp({ duringIdle: 3.0, duringUserAction: 1.0, duringNetworkWait: 2.0 })
  .subtitlesFromSrt(generatedSrtPath)
  .textProcessing({ builtins: true })
  .autoZoom({ inputLevel: 1.2, clickLevel: 1.0, centerBias: 0.3 })
  .cursorOverlay()
  .clickEffect({ sound: true })

if (introPath) pipeline = pipeline.intro({ path: introPath })
if (outroPath) pipeline = pipeline.outro({ path: outroPath })

pipeline = pipeline
  .voiceover(ElevenLabsProvider({ voiceId, modelId: 'eleven_multilingual_v2', languageCode: lang }))
  .render({ format: 'mp4', resolution: '4k', fps: 120, burnSubtitles: true, subtitleStyle: { ... } })

await pipeline.toFile(outputPath)
```

## CLI Interface

```
recast-studio [options] <url>

Arguments:
  url                         URL to open in the browser

Recording:
  --viewport <WxH>            Browser viewport (default: 1920x1080)
  --load-storage <path>       Pre-load auth state (cookies, localStorage)
  --ignore-https-errors       Ignore certificate errors

AI:
  --lang <code>               Voiceover language ISO 639-1 (default: cs)
  --tone <tone>               Voiceover tone: marketing | technical | neutral (default: marketing)

Video:
  -o, --output <path>         Output file (default: ./demo.mp4)
  --voice <id>                ElevenLabs voice ID (default: project default)
  --no-voiceover              Skip TTS, subtitles only
  --intro <path>              Intro video file
  --outro <path>              Outro video file
  --resolution <res>          720p | 1080p | 1440p | 4k (default: 4k)

Debug:
  --keep-trace                Don't delete trace directory after completion
  --dry-run                   Record + analyze only, don't render
```

## Files to Create

| File | Purpose |
|------|---------|
| `src/studio/cli.ts` | CLI entry point — parseArgs, orchestrate 3 phases, console output |
| `src/studio/recorder.ts` | `record(url, options)` — launch browser, capture trace + video |
| `src/studio/analyzer.ts` | `analyze(tracePath, options)` — parse trace, call Claude, return structured result |
| `src/studio/prompts.ts` | System prompt template for Claude (action analysis + voiceover generation) |
| `src/studio/srt-builder.ts` | Convert analyzer output (steps + timestamps) into SRT file |
| `src/studio/types.ts` | `StudioConfig`, `AnalysisResult`, `StudioStep` interfaces |

## Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add `"recast-studio": "./dist/studio/cli.js"` to `bin`, add `@anthropic-ai/sdk` as optional peerDependency |
| `src/index.ts` | No changes — studio is a separate entry point, not part of the library API |
| `tsconfig.json` | Ensure `src/studio/` is included in compilation |

## Dependencies

- **New peerDependency (optional):** `@anthropic-ai/sdk` — only needed when using recast-studio
- **Environment variables:** `ANTHROPIC_API_KEY` for Claude, `ELEVENLABS_API_KEY` for TTS
- **Existing:** `@playwright/test` (already peer dep), ffmpeg on PATH

## Edge Cases

1. **User closes browser immediately** — detect 0 actions, show error "No interactions recorded"
2. **Claude returns invalid JSON** — retry once with the parsing error as context; if still fails, show raw response and ask user to report
3. **No ANTHROPIC_API_KEY** — clear error message with setup instructions
4. **No ELEVENLABS_API_KEY with voiceover** — suggest `--no-voiceover` or setup instructions
5. **Password fields** — analyzer receives `value: "***"` (Playwright masks password inputs in traces), Claude's prompt explicitly ignores password actions for voiceover
6. **Very long sessions (100+ actions)** — Claude context window is sufficient; truncate to last 200 actions if needed
7. **Network errors during AI call** — retry with exponential backoff (max 3 attempts)
8. **load-storage for auth** — document workflow: first `npx playwright codegen --save-storage=auth.json`, then `npx recast-studio --load-storage=auth.json <url>`

## Test Strategy

**Unit tests:**
- `analyzer.test.ts` — mock Claude API, test JSON parsing, SRT generation, hideSteps predicate building
- `srt-builder.test.ts` — timestamp mapping from action indices to SRT entries
- `prompts.test.ts` — prompt template generation with different languages/tones

**Integration tests (require Playwright):**
- `recorder.test.ts` — record a session on a local test page, verify trace.zip and video.webm are created
- End-to-end: record → analyze (with mocked Claude) → recast pipeline → verify output video exists

**Manual testing:**
- Record real session on Codexis app, verify video quality and voiceover relevance
