# recast-studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CLI tool (`recast-studio`) that lets non-technical users record a browser session, have Claude generate voiceover scripts, and produce a polished demo video — all in one command.

**Architecture:** Three-phase pipeline: (1) Playwright browser recording → trace.zip, (2) Claude API analysis → SRT + hide predicate, (3) standard recast pipeline → MP4. All phases orchestrated by a single CLI entry point.

**Tech Stack:** TypeScript (ESM, NodeNext), Playwright (recording), Anthropic SDK (Claude API), existing playwright-recast pipeline, vitest for tests.

---

### Task 1: Types and interfaces

**Files:**
- Create: `src/studio/types.ts`

- [ ] **Step 1: Create studio types file**

```typescript
// src/studio/types.ts

/** CLI options parsed from command line */
export interface StudioConfig {
  url: string
  output: string
  viewport: { width: number; height: number }
  loadStorage?: string
  ignoreHttpsErrors: boolean
  lang: string
  tone: 'marketing' | 'technical' | 'neutral'
  voice?: string
  noVoiceover: boolean
  intro?: string
  outro?: string
  resolution: string
  keepTrace: boolean
  dryRun: boolean
}

/** A single step from Claude's analysis */
export interface AnalysisStep {
  actionIndices: number[]
  hidden: boolean
  voiceover: string | null
}

/** Full analysis result from Claude */
export interface AnalysisResult {
  title: string
  steps: AnalysisStep[]
}

/** Simplified action sent to Claude for analysis */
export interface ActionSummary {
  index: number
  method: string
  selector?: string
  url?: string
  value?: string
  timestamp: number
}

/** Output from the recorder phase */
export interface RecordingResult {
  traceDir: string
  tracePath: string
  videoPath: string
  actionCount: number
  durationMs: number
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/studio/types.ts
git commit -m "feat(studio): add type definitions for recast-studio"
```

---

### Task 2: SRT builder (with TDD)

**Files:**
- Create: `src/studio/srt-builder.ts`
- Create: `tests/unit/studio/srt-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/studio/srt-builder.test.ts
import { describe, it, expect } from 'vitest'
import { buildSrt } from '../../../src/studio/srt-builder'
import type { AnalysisStep } from '../../../src/studio/types'

const actions = [
  { startTime: 0, endTime: 1000 },
  { startTime: 2000, endTime: 3000 },
  { startTime: 3500, endTime: 4000 },
  { startTime: 5000, endTime: 6000 },
  { startTime: 8000, endTime: 9000 },
  { startTime: 10000, endTime: 12000 },
  { startTime: 14000, endTime: 15000 },
  { startTime: 18000, endTime: 19000 },
]

describe('buildSrt', () => {
  it('generates SRT entries for visible steps only', () => {
    const steps: AnalysisStep[] = [
      { actionIndices: [0], hidden: true, voiceover: null },
      { actionIndices: [1, 2], hidden: false, voiceover: 'First visible step.' },
      { actionIndices: [3], hidden: false, voiceover: 'Second visible step.' },
    ]
    const srt = buildSrt(steps, actions)
    expect(srt).toContain('First visible step.')
    expect(srt).toContain('Second visible step.')
    expect(srt).not.toContain('null')
    // Two SRT entries (hidden step excluded)
    const blocks = srt.trim().split(/\n\n+/)
    expect(blocks).toHaveLength(2)
  })

  it('uses first action timestamp as start time', () => {
    const steps: AnalysisStep[] = [
      { actionIndices: [3], hidden: false, voiceover: 'Step at 5s.' },
    ]
    const srt = buildSrt(steps, actions)
    expect(srt).toContain('00:00:05,000')
  })

  it('uses last action endTime of next step (or +5s) as end time', () => {
    const steps: AnalysisStep[] = [
      { actionIndices: [1], hidden: false, voiceover: 'First.' },
      { actionIndices: [3], hidden: false, voiceover: 'Second.' },
    ]
    const srt = buildSrt(steps, actions)
    // First step ends when second step starts (action index 3 → 5000ms)
    expect(srt).toContain('00:00:02,000 --> 00:00:05,000')
  })

  it('handles steps with no voiceover (skips them)', () => {
    const steps: AnalysisStep[] = [
      { actionIndices: [0], hidden: false, voiceover: null },
      { actionIndices: [1], hidden: false, voiceover: 'Has text.' },
    ]
    const srt = buildSrt(steps, actions)
    const blocks = srt.trim().split(/\n\n+/)
    expect(blocks).toHaveLength(1)
    expect(srt).toContain('Has text.')
  })

  it('returns empty string when no visible steps with voiceover', () => {
    const steps: AnalysisStep[] = [
      { actionIndices: [0], hidden: true, voiceover: null },
    ]
    const srt = buildSrt(steps, actions)
    expect(srt).toBe('')
  })

  it('numbers SRT entries sequentially starting from 1', () => {
    const steps: AnalysisStep[] = [
      { actionIndices: [0], hidden: true, voiceover: null },
      { actionIndices: [1], hidden: false, voiceover: 'A.' },
      { actionIndices: [3], hidden: false, voiceover: 'B.' },
      { actionIndices: [5], hidden: false, voiceover: 'C.' },
    ]
    const srt = buildSrt(steps, actions)
    const blocks = srt.trim().split(/\n\n+/)
    expect(blocks[0]).toMatch(/^1\n/)
    expect(blocks[1]).toMatch(/^2\n/)
    expect(blocks[2]).toMatch(/^3\n/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Work/playwright-recast && bun test tests/unit/studio/srt-builder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement srt-builder**

```typescript
// src/studio/srt-builder.ts
import type { AnalysisStep } from './types.js'

function formatSrtTime(ms: number): string {
  const rounded = Math.round(ms)
  const h = Math.floor(rounded / 3600000)
  const m = Math.floor((rounded % 3600000) / 60000)
  const s = Math.floor((rounded % 60000) / 1000)
  const mil = rounded % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mil).padStart(3, '0')}`
}

/**
 * Build an SRT string from analysis steps and trace action timings.
 *
 * Only visible steps with non-null voiceover are included.
 * Timing: start = first action in step, end = first action of next visible step (or start + 5s).
 */
export function buildSrt(
  steps: AnalysisStep[],
  actions: Array<{ startTime: number; endTime: number }>,
): string {
  // Collect visible steps with voiceover and their start times
  const visible = steps
    .filter((s) => !s.hidden && s.voiceover !== null)
    .map((s) => ({
      voiceover: s.voiceover!,
      startMs: actions[s.actionIndices[0]!]?.startTime ?? 0,
      actionIndices: s.actionIndices,
    }))

  if (visible.length === 0) return ''

  const entries: string[] = []

  for (let i = 0; i < visible.length; i++) {
    const step = visible[i]!
    const startMs = step.startMs
    // End time = start of next visible step, or current start + 5000ms
    const endMs = i + 1 < visible.length
      ? visible[i + 1]!.startMs
      : startMs + 5000

    entries.push(
      `${i + 1}\n${formatSrtTime(startMs)} --> ${formatSrtTime(endMs)}\n${step.voiceover}`,
    )
  }

  return entries.join('\n\n') + '\n'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Work/playwright-recast && bun test tests/unit/studio/srt-builder.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/studio/srt-builder.ts tests/unit/studio/srt-builder.test.ts
git commit -m "feat(studio): add SRT builder with tests"
```

---

### Task 3: Claude prompt template

**Files:**
- Create: `src/studio/prompts.ts`
- Create: `tests/unit/studio/prompts.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/studio/prompts.test.ts
import { describe, it, expect } from 'vitest'
import { buildAnalysisPrompt } from '../../../src/studio/prompts'
import type { ActionSummary } from '../../../src/studio/types'

describe('buildAnalysisPrompt', () => {
  const actions: ActionSummary[] = [
    { index: 0, method: 'goto', url: 'https://example.com', timestamp: 0 },
    { index: 1, method: 'click', selector: 'button.login', timestamp: 2000 },
    { index: 2, method: 'fill', selector: '#username', value: 'user@test.com', timestamp: 3000 },
  ]

  it('returns system and user messages', () => {
    const result = buildAnalysisPrompt(actions, { lang: 'cs', tone: 'marketing' })
    expect(result.system).toContain('product demo video')
    expect(result.user).toContain('goto')
    expect(result.user).toContain('button.login')
  })

  it('includes language in system prompt', () => {
    const result = buildAnalysisPrompt(actions, { lang: 'en', tone: 'marketing' })
    expect(result.system).toContain('en')
  })

  it('includes tone in system prompt', () => {
    const result = buildAnalysisPrompt(actions, { lang: 'cs', tone: 'technical' })
    expect(result.system).toContain('technical')
  })

  it('masks password values', () => {
    const pwActions: ActionSummary[] = [
      { index: 0, method: 'fill', selector: '#password', value: 'secret123', timestamp: 0 },
    ]
    const result = buildAnalysisPrompt(pwActions, { lang: 'cs', tone: 'marketing' })
    expect(result.user).not.toContain('secret123')
    expect(result.user).toContain('***')
  })

  it('serializes actions as JSON in user message', () => {
    const result = buildAnalysisPrompt(actions, { lang: 'cs', tone: 'marketing' })
    // Should be valid JSON embedded in the user message
    const jsonMatch = result.user.match(/\[[\s\S]*\]/)
    expect(jsonMatch).not.toBeNull()
    const parsed = JSON.parse(jsonMatch![0])
    expect(parsed).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Work/playwright-recast && bun test tests/unit/studio/prompts.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement prompts module**

```typescript
// src/studio/prompts.ts
import type { ActionSummary } from './types.js'

const PASSWORD_SELECTORS = /password|passwd|pwd|secret/i

export function buildAnalysisPrompt(
  actions: ActionSummary[],
  options: { lang: string; tone: string },
): { system: string; user: string } {
  // Mask password values
  const sanitized = actions.map((a) => {
    if (a.value && a.selector && PASSWORD_SELECTORS.test(a.selector)) {
      return { ...a, value: '***' }
    }
    return a
  })

  const system = `You are a product demo video script writer. Your job is to analyze raw browser interaction actions and produce a structured video script.

Instructions:
- Group related actions into logical steps (e.g., login = multiple clicks/fills grouped as one step)
- Mark setup/navigation actions as hidden (they won't appear in the video narration)
- Write voiceover text for each visible step in language: ${options.lang}
- Tone: ${options.tone} — ${options.tone === 'marketing' ? 'benefit-focused, professional, concise. Highlight value for the user.' : options.tone === 'technical' ? 'precise, factual, describe what happens step by step.' : 'clear, neutral, informative.'}
- Voiceover should describe WHAT the user achieves, not the mechanical click/fill actions
- Ignore password fields — never mention credentials in voiceover
- Each voiceover text should be 1-2 sentences, suitable for TTS narration

Respond with ONLY valid JSON matching this schema:
{
  "title": "string — short title for the demo video",
  "steps": [
    {
      "actionIndices": [0, 1, 2],
      "hidden": true,
      "voiceover": null
    },
    {
      "actionIndices": [3, 4],
      "hidden": false,
      "voiceover": "Voiceover text for this step."
    }
  ]
}

Rules:
- Every action index must appear in exactly one step
- actionIndices must be sorted ascending within each step
- Steps must be sorted by their first actionIndex
- hidden steps must have voiceover: null
- visible steps must have voiceover as a non-empty string`

  const user = `Analyze these ${sanitized.length} browser actions and create a demo video script:

${JSON.stringify(sanitized, null, 2)}`

  return { system, user }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Work/playwright-recast && bun test tests/unit/studio/prompts.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/studio/prompts.ts tests/unit/studio/prompts.test.ts
git commit -m "feat(studio): add Claude prompt template with tests"
```

---

### Task 4: Analyzer (Claude API integration)

**Files:**
- Create: `src/studio/analyzer.ts`
- Create: `tests/unit/studio/analyzer.test.ts`

- [ ] **Step 1: Write failing tests (mocked Claude)**

```typescript
// tests/unit/studio/analyzer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { analyzeActions } from '../../../src/studio/analyzer'
import type { ActionSummary } from '../../../src/studio/types'

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(),
      }
    },
  }
})

const sampleActions: ActionSummary[] = [
  { index: 0, method: 'goto', url: 'https://example.com', timestamp: 0 },
  { index: 1, method: 'click', selector: 'button.login', timestamp: 2000 },
  { index: 2, method: 'fill', selector: '#search', value: 'test query', timestamp: 5000 },
  { index: 3, method: 'click', selector: '.result', timestamp: 10000 },
]

describe('analyzeActions', () => {
  it('parses valid Claude JSON response', async () => {
    const mockResponse = {
      title: 'Test Demo',
      steps: [
        { actionIndices: [0, 1], hidden: true, voiceover: null },
        { actionIndices: [2], hidden: false, voiceover: 'Search for content.' },
        { actionIndices: [3], hidden: false, voiceover: 'Open the result.' },
      ],
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const mockCreate = vi.mocked(new Anthropic().messages.create)
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(mockResponse) }],
    } as any)

    const result = await analyzeActions(sampleActions, { lang: 'en', tone: 'marketing' })
    expect(result.title).toBe('Test Demo')
    expect(result.steps).toHaveLength(3)
    expect(result.steps[0]!.hidden).toBe(true)
    expect(result.steps[1]!.voiceover).toBe('Search for content.')
  })

  it('throws on missing ANTHROPIC_API_KEY', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await expect(
        analyzeActions(sampleActions, { lang: 'en', tone: 'marketing' }),
      ).rejects.toThrow('ANTHROPIC_API_KEY')
    } finally {
      if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Work/playwright-recast && bun test tests/unit/studio/analyzer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement analyzer**

```typescript
// src/studio/analyzer.ts
import type { ActionSummary, AnalysisResult } from './types.js'
import { buildAnalysisPrompt } from './prompts.js'

/**
 * Send trace actions to Claude for analysis.
 * Returns structured steps with voiceover text.
 */
export async function analyzeActions(
  actions: ActionSummary[],
  options: { lang: string; tone: string },
): Promise<AnalysisResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required.\n' +
      'Get your key at https://console.anthropic.com/settings/keys\n' +
      'Then: export ANTHROPIC_API_KEY=sk-ant-...',
    )
  }

  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey })

  const { system, user } = buildAnalysisPrompt(actions, options)

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  })

  const text = response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')

  return parseAnalysisResponse(text)
}

function parseAnalysisResponse(text: string): AnalysisResult {
  // Extract JSON from response (Claude may wrap in markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error(`Claude did not return valid JSON. Response:\n${text.substring(0, 500)}`)
  }

  const parsed = JSON.parse(jsonMatch[0]) as AnalysisResult

  if (!parsed.title || !Array.isArray(parsed.steps)) {
    throw new Error(`Invalid analysis format. Expected { title, steps[] }. Got: ${JSON.stringify(parsed).substring(0, 200)}`)
  }

  return parsed
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Work/playwright-recast && bun test tests/unit/studio/analyzer.test.ts`
Expected: all 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/studio/analyzer.ts tests/unit/studio/analyzer.test.ts
git commit -m "feat(studio): add Claude analyzer with mocked tests"
```

---

### Task 5: Browser recorder

**Files:**
- Create: `src/studio/recorder.ts`

This uses Playwright programmatic API. No unit tests here — it requires a real browser. Will be tested manually and via integration test later.

- [ ] **Step 1: Implement recorder**

```typescript
// src/studio/recorder.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RecordingResult } from './types.js'

export interface RecordOptions {
  viewport: { width: number; height: number }
  loadStorage?: string
  ignoreHttpsErrors: boolean
}

/**
 * Open a browser, let the user interact, and capture a Playwright trace + video.
 * Returns when the user closes the browser.
 */
export async function record(url: string, outputDir: string, options: RecordOptions): Promise<RecordingResult> {
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

  // Load pre-saved auth state if provided
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
    // Browser already closed — tracing.stop may fail, but trace.zip is usually written
  }

  // Find the recorded video file
  const files = fs.readdirSync(outputDir)
  const videoFile = files.find((f) => f.endsWith('.webm'))
  const videoPath = videoFile ? path.join(outputDir, videoFile) : ''

  // Count actions from trace (quick parse)
  let actionCount = 0
  let durationMs = 0
  try {
    const { parseTrace } = await import('../parse/trace-parser.js')
    const trace = await parseTrace(tracePath)
    actionCount = trace.actions.length
    durationMs = (trace.metadata.endTime as number) - (trace.metadata.startTime as number)
    trace.frameReader.dispose()
  } catch {
    // Non-critical — just for display
  }

  return { traceDir: outputDir, tracePath, videoPath, actionCount, durationMs }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/studio/recorder.ts
git commit -m "feat(studio): add browser recorder via Playwright API"
```

---

### Task 6: CLI entry point and orchestrator

**Files:**
- Create: `src/studio/cli.ts`

- [ ] **Step 1: Implement CLI**

```typescript
#!/usr/bin/env node
// src/studio/cli.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import type { StudioConfig, ActionSummary } from './types.js'
import { record } from './recorder.js'
import { analyzeActions } from './analyzer.js'
import { buildSrt } from './srt-builder.js'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string', short: 'o', default: './demo.mp4' },
    viewport: { type: 'string', default: '1920x1080' },
    'load-storage': { type: 'string' },
    'ignore-https-errors': { type: 'boolean', default: false },
    lang: { type: 'string', default: 'cs' },
    tone: { type: 'string', default: 'marketing' },
    voice: { type: 'string' },
    'no-voiceover': { type: 'boolean', default: false },
    intro: { type: 'string' },
    outro: { type: 'string' },
    resolution: { type: 'string', default: '4k' },
    'keep-trace': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
})

if (args.help || positionals.length === 0) {
  console.log(`
Usage: recast-studio [options] <url>

Record a browser session and generate a polished demo video.

Arguments:
  url                         URL to open in the browser

Recording:
  --viewport <WxH>            Browser viewport (default: 1920x1080)
  --load-storage <path>       Pre-load auth state (cookies, localStorage)
  --ignore-https-errors       Ignore certificate errors

AI:
  --lang <code>               Voiceover language ISO 639-1 (default: cs)
  --tone <tone>               marketing | technical | neutral (default: marketing)

Video:
  -o, --output <path>         Output file (default: ./demo.mp4)
  --voice <id>                ElevenLabs voice ID
  --no-voiceover              Skip TTS, subtitles only
  --intro <path>              Intro video file
  --outro <path>              Outro video file
  --resolution <res>          720p | 1080p | 1440p | 4k (default: 4k)

Debug:
  --keep-trace                Don't delete trace directory after completion
  --dry-run                   Record + analyze only, don't render
  -h, --help                  Show this help
`)
  process.exit(positionals.length === 0 && !args.help ? 1 : 0)
}

const url = positionals[0]!
const [vw, vh] = (args.viewport ?? '1920x1080').split('x').map(Number)

const config: StudioConfig = {
  url,
  output: args.output ?? './demo.mp4',
  viewport: { width: vw ?? 1920, height: vh ?? 1080 },
  loadStorage: args['load-storage'],
  ignoreHttpsErrors: args['ignore-https-errors'] ?? false,
  lang: args.lang ?? 'cs',
  tone: (args.tone ?? 'marketing') as StudioConfig['tone'],
  voice: args.voice,
  noVoiceover: args['no-voiceover'] ?? false,
  intro: args.intro,
  outro: args.outro,
  resolution: args.resolution ?? '4k',
  keepTrace: args['keep-trace'] ?? false,
  dryRun: args['dry-run'] ?? false,
}

async function main() {
  const tmpDir = path.join(process.cwd(), '.recast-studio-tmp')

  // ── Phase 1: Record ──
  console.log(`\n🎬  Opening browser at ${config.url}`)
  console.log('    Navigate and interact. Close the browser when done.\n')

  const recording = await record(config.url, tmpDir, {
    viewport: config.viewport,
    loadStorage: config.loadStorage,
    ignoreHttpsErrors: config.ignoreHttpsErrors,
  })

  if (recording.actionCount === 0) {
    console.error('❌  No interactions recorded. Nothing to process.')
    process.exit(1)
  }

  console.log(`✅  Session recorded (${(recording.durationMs / 1000).toFixed(0)}s, ${recording.actionCount} actions)\n`)

  // ── Phase 2: AI Analyze ──
  console.log('🤖  Analyzing with Claude...')

  // Parse trace to get action details for Claude
  const { parseTrace } = await import('../parse/trace-parser.js')
  const trace = await parseTrace(recording.tracePath)

  const actionSummaries: ActionSummary[] = trace.actions.map((a, i) => ({
    index: i,
    method: a.method,
    selector: a.params.selector as string | undefined,
    url: a.params.url as string | undefined,
    value: a.params.value as string | undefined,
    timestamp: a.startTime as number,
  }))

  trace.frameReader.dispose()

  const analysis = await analyzeActions(actionSummaries, {
    lang: config.lang,
    tone: config.tone,
  })

  const visibleSteps = analysis.steps.filter((s) => !s.hidden)
  const hiddenSteps = analysis.steps.filter((s) => s.hidden)
  console.log(`    → ${visibleSteps.length} meaningful steps (${hiddenSteps.length} hidden as setup)`)
  console.log(`    → Voiceover generated (${config.lang}, ${config.tone} tone)\n`)

  // Build SRT file
  const actionsForSrt = trace.actions.map((a) => ({
    startTime: a.startTime as number,
    endTime: a.endTime as number,
  }))
  // Re-parse trace to get fresh actions (frameReader was disposed)
  const srtContent = buildSrt(analysis.steps, actionsForSrt)
  const srtPath = path.join(tmpDir, 'subtitles.srt')
  fs.writeFileSync(srtPath, srtContent)

  if (config.dryRun) {
    console.log('🔍  Dry run — skipping video render.')
    console.log(`    Title: ${analysis.title}`)
    console.log(`    SRT: ${srtPath}`)
    for (const step of analysis.steps) {
      const status = step.hidden ? '  (hidden)' : ''
      console.log(`    [${step.actionIndices.join(',')}]${status} ${step.voiceover ?? '—'}`)
    }
    if (!config.keepTrace) fs.rmSync(tmpDir, { recursive: true, force: true })
    return
  }

  // ── Phase 3: Recast Pipeline ──
  console.log('🎥  Running recast pipeline...')

  const { Pipeline: Recast } = await import('../pipeline/pipeline.js')
  const { ElevenLabsProvider } = await import('../voiceover/providers/elevenlabs.js')

  // Build set of hidden action indices for hideSteps
  const hiddenIndices = new Set<number>()
  for (const step of analysis.steps) {
    if (step.hidden) {
      for (const idx of step.actionIndices) hiddenIndices.add(idx)
    }
  }

  let pipeline = Recast.from(tmpDir)
    .parse()
    .hideSteps((action) => {
      const idx = actionsForSrt.findIndex(
        (a) => a.startTime === (action.startTime as number) && a.endTime === (action.endTime as number),
      )
      return hiddenIndices.has(idx)
    })
    .speedUp({ duringIdle: 3.0, duringUserAction: 1.0, duringNetworkWait: 2.0 })
    .subtitlesFromSrt(srtPath)
    .textProcessing({ builtins: true })
    .autoZoom({ inputLevel: 1.2, clickLevel: 1.0, centerBias: 0.3 })
    .cursorOverlay()
    .clickEffect({ sound: true })

  if (config.intro) pipeline = pipeline.intro({ path: path.resolve(config.intro) })
  if (config.outro) pipeline = pipeline.outro({ path: path.resolve(config.outro) })

  if (!config.noVoiceover) {
    pipeline = pipeline.voiceover(
      ElevenLabsProvider({
        voiceId: config.voice ?? undefined,
        modelId: 'eleven_multilingual_v2',
        languageCode: config.lang,
      }),
    )
  }

  pipeline = pipeline.render({
    format: 'mp4',
    resolution: config.resolution as '720p' | '1080p' | '1440p' | '4k',
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

  const outputPath = path.resolve(config.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  await pipeline.toFile(outputPath)

  const size = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1)
  console.log(`\n✅  ${path.basename(outputPath)} (${size} MB)\n`)

  // Cleanup
  if (!config.keepTrace) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } else {
    console.log(`    Trace kept at: ${tmpDir}`)
  }
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
git commit -m "feat(studio): add CLI entry point and orchestrator"
```

---

### Task 7: Package.json and dependency setup

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add bin entry, peerDependency, devDependency**

In `package.json`, make these changes:

Add to `"bin"`:
```json
"recast-studio": "./dist/studio/cli.js"
```

Add to `"peerDependencies"`:
```json
"@anthropic-ai/sdk": ">=0.80.0"
```

Add to `"peerDependenciesMeta"`:
```json
"@anthropic-ai/sdk": {
  "optional": true
}
```

Add to `"devDependencies"`:
```json
"@anthropic-ai/sdk": "^0.82.0"
```

- [ ] **Step 2: Install the new dependency**

Run: `cd ~/Work/playwright-recast && bun install`
Expected: successful install

- [ ] **Step 3: Build to verify everything compiles**

Run: `cd ~/Work/playwright-recast && bun run build`
Expected: no errors, `dist/studio/cli.js` exists

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `cd ~/Work/playwright-recast && bun test`
Expected: all tests pass (existing + new studio tests)

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore(studio): add recast-studio bin entry and @anthropic-ai/sdk dependency"
```

---

### Task 8: Manual local testing

**No files created.** This is a verification task.

- [ ] **Step 1: Set environment variables**

Ensure `ANTHROPIC_API_KEY` and `ELEVENLABS_API_KEY` are set in the shell.

- [ ] **Step 2: Build the project**

Run: `cd ~/Work/playwright-recast && bun run build`

- [ ] **Step 3: Test help output**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js --help`
Expected: help text with all options displayed

- [ ] **Step 4: Test dry-run on a real URL**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js --dry-run --keep-trace https://example.com`
Expected: browser opens, user clicks around, closes browser, Claude analyzes, SRT is printed (no video render).

- [ ] **Step 5: Test full pipeline (if dry-run worked)**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js -o /tmp/studio-test.mp4 --resolution 1080p https://example.com`
Expected: full video generated at `/tmp/studio-test.mp4`

- [ ] **Step 6: Test with --no-voiceover**

Run: `cd ~/Work/playwright-recast && node dist/studio/cli.js --no-voiceover --dry-run https://example.com`
Expected: works without ELEVENLABS_API_KEY

---

### Task 9: Final commit — all tests green

- [ ] **Step 1: Run full test suite**

Run: `cd ~/Work/playwright-recast && bun test`
Expected: all tests pass

- [ ] **Step 2: Build clean**

Run: `cd ~/Work/playwright-recast && rm -rf dist && bun run build`
Expected: clean build, `dist/studio/cli.js` exists

- [ ] **Step 3: Verify shebang**

Run: `head -1 dist/studio/cli.js`
Expected: `#!/usr/bin/env node` (TypeScript compiles it through from the source)

Note: If the shebang is missing (tsc strips it), add a `postbuild` script or manually prepend it. This is a known TypeScript limitation — the `#!/usr/bin/env node` comment in the source may not survive compilation. Fix: add to package.json scripts:
```json
"postbuild": "echo '#!/usr/bin/env node' | cat - dist/studio/cli.js > /tmp/cli-shebang && mv /tmp/cli-shebang dist/studio/cli.js"
```

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "feat(studio): recast-studio CLI — record, analyze, render in one command"
```
