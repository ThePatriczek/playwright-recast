---
name: studio-workflow
description: Generate a polished demo video from a Playwright trace recording. Reads trace actions, writes voiceover scripts, generates SRT subtitles, and runs the recast pipeline. Use when the user has recorded a browser session with recast-studio and wants to produce a video, or says "generate video from trace", "process my recording", "make a demo".
---

# Studio Workflow

Generate a demo video from a raw Playwright trace recorded by `recast-studio`.

## When to Use

- User recorded a session with `recast-studio` and wants to generate a video
- User says "generate video from trace", "process my recording", "make a demo from this trace"
- User points to a directory with `trace.zip` and `.webm` files

## Input

A directory path containing:
- `trace.zip` — Playwright trace
- `*.webm` — screen recording

Produced by: `npx recast-studio <url>`

## Workflow

Execute these steps in order. Each step produces artifacts the next step needs.

### Step 1: Parse the trace

Read the trace directory and parse `trace.zip` to extract all actions. Use the playwright-recast `parseTrace` function:

```typescript
const { parseTrace } = await import('<recast-root>/src/parse/trace-parser.js')
const trace = await parseTrace('<input-dir>/trace.zip')
```

List all actions with their index, method, selector/URL, value, and timestamp. Mask any values from password-like selectors (containing "password", "passwd", "pwd", "secret").

Present the action list to yourself for analysis.

### Step 2: Analyze and group actions

Group the actions into logical steps. For each step, decide:

**Hidden steps** — setup that should not appear in the video:
- Navigation to the starting URL (`goto`)
- Login flows (fill username + fill password + click submit)
- Cookie consent, onboarding dialogs
- Any action the viewer doesn't need to see

**Visible steps** — the actual demo content:
- The core user journey being demonstrated
- Each visible step groups 1-3 related actions (e.g., click input + fill value = one step)

Track which action indices belong to each step and whether it's hidden.

### Step 3: Write voiceover

For each visible step, write 1-2 sentences of voiceover text. Follow the script-writer skill guidelines:

- **Marketing tone** — benefit-focused, professional, concise
- **Language** — infer from the UI language, user's instructions, or conversation context
- Never describe mechanical clicks — describe what the user ACHIEVES
- Never mention credentials or passwords
- Each sentence should be natural for TTS (ElevenLabs)
- First visible step = hook (why should the viewer care?)
- Last visible step = result + soft CTA

### Step 4: Generate SRT file

Create an SRT file mapping voiceover text to trace timestamps.

**Timing rules:**
- Each entry starts at the first action's `startTime` in that step
- Each entry ends at the start of the next visible step
- Last entry ends at its start + 5000ms
- Times are trace-relative (milliseconds from trace start)
- Use standard SRT format: `HH:MM:SS,mmm --> HH:MM:SS,mmm`

**SRT numbering:** sequential starting from 1, only visible steps with voiceover.

Write the SRT to `<input-dir>/subtitles.srt`.

### Step 5: Build and run recast pipeline

Create a TypeScript script that runs the recast pipeline. Key decisions:

**hideSteps predicate:** Build a `Set<number>` of hidden action indices. The predicate matches actions by their timestamp against the original trace actions.

**Speed:** `duringIdle: 3.0, duringUserAction: 1.0, duringNetworkWait: 2.0`

**Visual effects:** autoZoom (inputLevel: 1.2), cursorOverlay, clickEffect with sound.

**Voiceover:** ElevenLabsProvider with `eleven_multilingual_v2` model. Language code from the voiceover text language. Requires `ELEVENLABS_API_KEY`.

**Subtitles:** burn into video with styled ASS subtitles (Arial, bold, white background).

**Intro/outro:** if user provides paths, add `.intro()` and `.outro()` to the pipeline.

**Output:** `<input-dir>/demo.mp4` (or user-specified path).

```typescript
import { Recast, ElevenLabsProvider } from 'playwright-recast'

const hiddenActionIndices = new Set([/* from step 2 */])

let pipeline = Recast.from('<input-dir>')
  .parse()
  .hideSteps((action) => {
    // Match hidden actions by timestamp
    const idx = traceActions.findIndex(
      a => a.startTime === action.startTime && a.endTime === action.endTime
    )
    return hiddenActionIndices.has(idx)
  })
  .speedUp({ duringIdle: 3.0, duringUserAction: 1.0, duringNetworkWait: 2.0 })
  .subtitlesFromSrt('<input-dir>/subtitles.srt')
  .textProcessing({ builtins: true })
  .autoZoom({ inputLevel: 1.2, clickLevel: 1.0, centerBias: 0.3 })
  .cursorOverlay()
  .clickEffect({ sound: true })
  .voiceover(ElevenLabsProvider({
    modelId: 'eleven_multilingual_v2',
    languageCode: '<detected-language>',
  }))
  .render({
    format: 'mp4',
    resolution: '4k',
    fps: 120,
    burnSubtitles: true,
    subtitleStyle: {
      fontFamily: 'Arial',
      fontSize: 96,
      primaryColor: '#1a1a1a',
      backgroundColor: '#FFFFFF',
      backgroundOpacity: 0.75,
      padding: 40,
      bold: true,
      position: 'bottom',
      marginVertical: 100,
      marginHorizontal: 200,
      chunkOptions: { maxCharsPerLine: 55 },
    },
  })

await pipeline.toFile('<input-dir>/demo.mp4')
```

### Step 6: Report result

After the pipeline completes, report:
- Video path and file size
- Number of visible / hidden steps
- Voiceover texts used
- Duration of output video

## User Interaction

- If the trace has fewer than 3 actions, warn and ask if they want to proceed
- If unsure about which actions are setup vs. demo, ASK the user before proceeding
- If user wants different voiceover tone/language, regenerate SRT and re-run pipeline
- Support `--no-voiceover` — skip TTS, keep subtitles only
- If `ELEVENLABS_API_KEY` is not set, inform user and suggest subtitle-only mode

## Example Session

```
User: /studio-workflow .recast-studio/

Agent: Reading trace from .recast-studio/trace.zip...

Found 9 actions:
  0: goto https://app.codexis.cz
  1: click "Přihlásit se"
  2: fill #username → "jana@..."
  3: fill #password → "***"
  4: click "Přihlásit"
  5: click .search-input
  6: fill .search-input → "pracovní právo"
  7: click .result-item
  8: click "Stáhnout"

Grouping into steps:
  [hidden] Actions 0-4: Login and navigation
  [visible] Actions 5-6: "Do vyhledávače zadáme klíčový pojem z oblasti pracovního práva."
  [visible] Action 7: "Z výsledků vybereme nejrelevantnější dokument."
  [visible] Action 8: "Jedním kliknutím dokument stáhneme pro offline práci."

Writing SRT to .recast-studio/subtitles.srt...
Running recast pipeline...
  ✔ Speed processing (38s → 18s)
  ✔ Voiceover (ElevenLabs, 3 segments)
  ✔ Click effects + cursor + auto-zoom
  ✔ Rendering 4K

✅ .recast-studio/demo.mp4 (8.2 MB)
```
