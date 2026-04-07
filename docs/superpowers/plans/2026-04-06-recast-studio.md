# recast-studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a recording CLI (`recast-studio`) and a Claude Code skill (`studio-workflow`) that together let non-technical users create product demo videos from browser sessions.

**Architecture:** CLI handles only recording (Playwright browser → trace.zip). The Claude Code skill handles AI analysis (voiceover generation) and recast pipeline execution. No AI SDK in code — the agent IS the AI.

**Tech Stack:** TypeScript (ESM, NodeNext), Playwright (recording), existing playwright-recast pipeline, vitest for tests.

---

### Task 1: Types

**Files:**
- Create: `src/studio/types.ts`

- [ ] **Step 1: Create types file**

```typescript
// src/studio/types.ts

/** Options for the browser recorder */
export interface RecordOptions {
  viewport: { width: number; height: number }
  loadStorage?: string
  ignoreHttpsErrors: boolean
}

/** Output from the recorder */
export interface RecordingResult {
  /** Directory containing trace.zip and video */
  outputDir: string
  /** Path to trace.zip */
  tracePath: string
  /** Path to recorded .webm video */
  videoPath: string
  /** Number of actions detected in trace */
  actionCount: number
  /** Total recording duration in ms */
  durationMs: number
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/studio/types.ts
git commit -m "feat(studio): add recording types"
```

---

### Task 2: Browser recorder

**Files:**
- Create: `src/studio/recorder.ts`

- [ ] **Step 1: Implement recorder**

```typescript
// src/studio/recorder.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RecordOptions, RecordingResult } from './types.js'

/**
 * Open a browser, let the user interact, and capture a Playwright trace + video.
 * Returns when the user closes the browser.
 */
export async function record(
  url: string,
  outputDir: string,
  options: RecordOptions,
): Promise<RecordingResult> {
  const { chromium } = await import('playwright')

  fs.mkdirSync(outputDir, { recursive: true })

  const browser = await chromium.launch({ headless: false })

  const contextOptions: Record<string, unknown> = {
    viewport: options.viewport,
    recordVideo: {
      dir: outputDir,
      size: options.viewport,
    },
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
  }

  if (options.loadStorage) {
    const storagePath = path.resolve(options.loadStorage)
    if (!fs.existsSync(storagePath)) {
      throw new Error(`Storage file not found: ${storagePath}`)
    }
    contextOptions.storageState = storagePath
  }

  const context = await browser.newContext(contextOptions)
  await context.tracing.start({ screenshots: true, snapshots: true })

  const page = await context.newPage()
  await page.goto(url)

  // Wait for the user to close the browser
  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => resolve())
  })

  const tracePath = path.join(outputDir, 'trace.zip')
  try {
    await context.tracing.stop({ path: tracePath })
  } catch {
    // Browser already closed — trace.zip is usually written before disconnect
  }

  // Find the recorded video file
  const files = fs.readdirSync(outputDir)
  const videoFile = files.find((f) => f.endsWith('.webm'))
  const videoPath = videoFile ? path.join(outputDir, videoFile) : ''

  // Quick parse for stats (non-critical)
  let actionCount = 0
  let durationMs = 0
  if (fs.existsSync(tracePath)) {
    try {
      const { parseTrace } = await import('../parse/trace-parser.js')
      const trace = await parseTrace(tracePath)
      actionCount = trace.actions.length
      durationMs = (trace.metadata.endTime as number) - (trace.metadata.startTime as number)
      trace.frameReader.dispose()
    } catch {
      // Non-critical — just for display
    }
  }

  return { outputDir, tracePath, videoPath, actionCount, durationMs }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/studio/recorder.ts
git commit -m "feat(studio): add browser recorder"
```

---

### Task 3: CLI entry point

**Files:**
- Create: `src/studio/cli.ts`

- [ ] **Step 1: Implement CLI**

```typescript
#!/usr/bin/env node
// src/studio/cli.ts
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { record } from './recorder.js'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o', default: '.recast-studio' },
    viewport: { type: 'string', default: '1920x1080' },
    'load-storage': { type: 'string' },
    'ignore-https-errors': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (args.help || positionals.length === 0) {
  console.log(`
Usage: recast-studio [options] <url>

Record a browser session as a Playwright trace for demo video generation.

Arguments:
  url                         URL to open in the browser

Options:
  -o, --output <dir>          Output directory (default: .recast-studio/)
  --viewport <WxH>            Browser viewport (default: 1920x1080)
  --load-storage <path>       Pre-load auth state (from playwright codegen --save-storage)
  --ignore-https-errors       Ignore certificate errors
  -h, --help                  Show this help

After recording, use the studio-workflow Claude Code skill to generate the video:
  > /studio-workflow .recast-studio/
`)
  process.exit(positionals.length === 0 && !args.help ? 1 : 0)
}

const url = positionals[0]!
const [vw, vh] = (args.viewport ?? '1920x1080').split('x').map(Number)
const outputDir = path.resolve(args.output ?? '.recast-studio')

async function main() {
  console.log(`\n🎬  Opening browser at ${url}`)
  console.log('    Navigate and interact. Close the browser when done.\n')

  const result = await record(url, outputDir, {
    viewport: { width: vw ?? 1920, height: vh ?? 1080 },
    loadStorage: args['load-storage'],
    ignoreHttpsErrors: args['ignore-https-errors'] ?? false,
  })

  if (result.actionCount === 0) {
    console.error('❌  No interactions recorded. Try again and click around before closing.')
    process.exit(1)
  }

  console.log(`✅  Trace saved to ${result.outputDir}/ (${(result.durationMs / 1000).toFixed(0)}s, ${result.actionCount} actions)`)
  console.log(`\n    Next: use the studio-workflow skill to generate the video:`)
  console.log(`    > /studio-workflow ${result.outputDir}/\n`)
}

main().catch((err) => {
  console.error('❌  Error:', err.message ?? err)
  process.exit(1)
})
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/studio/cli.ts
git commit -m "feat(studio): add CLI entry point"
```

---

### Task 4: Package.json setup

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add recast-studio bin entry**

Add `"recast-studio": "./dist/studio/cli.js"` to the `"bin"` object in `package.json`, so it becomes:

```json
"bin": {
  "playwright-recast": "./dist/cli.js",
  "recast-studio": "./dist/studio/cli.js"
},
```

- [ ] **Step 2: Build and verify**

Run: `cd ~/Work/playwright-recast && bun run build`
Expected: no errors, `dist/studio/cli.js` exists

- [ ] **Step 3: Verify CLI help works**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js --help`
Expected: help text displayed

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `cd ~/Work/playwright-recast && bun test`
Expected: all existing tests pass

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(studio): add recast-studio bin entry"
```

---

### Task 5: Claude Code skill — studio-workflow

**Files:**
- Create: `.claude/playwright-recast/skills/studio-workflow/SKILL.md`

This is the core intelligence — the Claude Code agent itself analyzes the trace and drives the pipeline. No compiled code, just a skill prompt.

- [ ] **Step 1: Create the skill**

```markdown
---
name: studio-workflow
description: Generate a polished demo video from a Playwright trace recording. Reads trace actions, writes voiceover scripts, generates SRT subtitles, and runs the recast pipeline. Use when the user has recorded a browser session with recast-studio and wants to produce a video.
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

### Step 1: Parse the trace

Read the trace.zip to understand what the user did:

```typescript
import { parseTrace } from '~/Work/playwright-recast/src/parse/trace-parser'
const trace = await parseTrace('<dir>/trace.zip')
```

List all actions with: method, selector/url, value (mask passwords), timestamp.

### Step 2: Analyze and group actions

As the agent, YOU analyze the actions. Group them into logical steps:

- **Hidden steps** — setup, login, navigation to starting point. These get hidden from the video.
- **Visible steps** — the actual demo content the viewer should see.

Rules:
- Login flows (goto + fill username + fill password + click submit) = one hidden step
- Related rapid actions (click input + fill value) = one visible step
- Each visible step gets a voiceover sentence

### Step 3: Write voiceover

For each visible step, write 1-2 sentences of voiceover text following the script-writer skill guidelines:
- Marketing tone, benefit-focused
- Language: match the UI language or user's request
- Never describe mechanical clicks — describe what the user ACHIEVES
- Never mention credentials

### Step 4: Generate SRT file

Create an SRT file mapping voiceover text to trace timestamps:

```
1
00:00:02,000 --> 00:00:07,000
Voiceover text for first visible step.

2
00:00:07,001 --> 00:00:14,000
Voiceover text for second visible step.
```

Timing: each entry starts at the first action's timestamp in that step. Ends at the start of the next visible step (or +5s for the last one).

Write the SRT to `<dir>/subtitles.srt`.

### Step 5: Run recast pipeline

Build and execute the pipeline. Adjust parameters based on the recording:

```typescript
import { Recast, ElevenLabsProvider } from 'playwright-recast'

const hiddenIndices = new Set([/* indices of hidden actions */])

let pipeline = Recast.from('<dir>')
  .parse()
  .hideSteps((action) => {
    // Match by timestamp to identify hidden actions
    return hiddenIndices.has(actionIndex)
  })
  .speedUp({ duringIdle: 3.0, duringUserAction: 1.0, duringNetworkWait: 2.0 })
  .subtitlesFromSrt('<dir>/subtitles.srt')
  .textProcessing({ builtins: true })
  .autoZoom({ inputLevel: 1.2, clickLevel: 1.0, centerBias: 0.3 })
  .cursorOverlay()
  .clickEffect({ sound: true })

// Add intro/outro if user requests
// pipeline = pipeline.intro({ path: '...' })
// pipeline = pipeline.outro({ path: '...' })

// Voiceover (requires ELEVENLABS_API_KEY)
pipeline = pipeline.voiceover(
  ElevenLabsProvider({
    modelId: 'eleven_multilingual_v2',
    languageCode: 'cs', // adjust to content language
  })
)

pipeline = pipeline.render({
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

await pipeline.toFile('<dir>/demo.mp4')
```

### Step 6: Report result

Tell the user:
- Video path and file size
- Number of steps (visible / hidden)
- Voiceover texts used
- Suggest `--keep-trace` if they want to re-render with different settings

## User Interaction

- If the trace has <3 actions, warn the user and ask if they want to proceed
- If unsure about which actions are setup vs. demo content, ASK the user
- If user wants to adjust voiceover tone/language, re-generate SRT and re-render
- Support `--no-voiceover` requests — skip TTS, keep subtitles only

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

I'll group these into steps:
  [hidden] Actions 0-4: Login flow
  [visible] Actions 5-6: "Do vyhledávače zadáme klíčový pojem z oblasti pracovního práva."
  [visible] Action 7: "Z výsledků vybereme nejrelevantnější dokument."
  [visible] Action 8: "Jedním kliknutím dokument stáhneme pro offline práci."

Generating SRT and running recast pipeline...

✅ demo.mp4 (8.2 MB) saved to .recast-studio/demo.mp4
```
```

- [ ] **Step 2: Commit**

```bash
git add .claude/playwright-recast/skills/studio-workflow/SKILL.md
git commit -m "feat(studio): add studio-workflow Claude Code skill"
```

---

### Task 6: Manual local testing

**No files created.** Verification task.

- [ ] **Step 1: Build the project**

Run: `cd ~/Work/playwright-recast && bun run build`

- [ ] **Step 2: Test CLI help**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js --help`
Expected: help text with usage, options, and "Next: use studio-workflow skill" hint

- [ ] **Step 3: Test recording on a real URL**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js -o /tmp/recast-test https://example.com`
Expected: browser opens, user clicks around, closes browser, trace saved to `/tmp/recast-test/`

- [ ] **Step 4: Verify trace output**

Run: `ls /tmp/recast-test/`
Expected: `trace.zip` and a `.webm` file exist

- [ ] **Step 5: Test with --load-storage**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js --load-storage /nonexistent.json https://example.com`
Expected: clear error "Storage file not found"

- [ ] **Step 6: Test the skill**

In Claude Code, invoke: `/studio-workflow /tmp/recast-test/`
Expected: agent reads trace, groups actions, writes SRT, runs pipeline, produces video

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd ~/Work/playwright-recast && bun test`
Expected: all tests pass

- [ ] **Step 2: Clean build**

Run: `cd ~/Work/playwright-recast && rm -rf dist && bun run build`
Expected: clean build, `dist/studio/cli.js` exists

- [ ] **Step 3: Check shebang**

Run: `head -1 dist/studio/cli.js`
Expected: `#!/usr/bin/env node`

If missing (tsc strips shebangs), add a postbuild script to `package.json`:
```json
"postbuild": "echo '#!/usr/bin/env node' | cat - dist/studio/cli.js > /tmp/cli-shebang && mv /tmp/cli-shebang dist/studio/cli.js"
```

- [ ] **Step 4: Commit if any fixes needed**

```bash
git add -A
git commit -m "feat(studio): recast-studio recording CLI + studio-workflow skill"
```
