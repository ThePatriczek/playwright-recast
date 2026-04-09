# Recast MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that wraps playwright-recast's recording, trace analysis, and rendering capabilities as tools, enabling any MCP-compatible AI agent to create demo videos conversationally.

**Architecture:** A `src/mcp/` directory in the playwright-recast repo containing a stdio-based MCP server with 5 tools (`record_session`, `analyze_trace`, `get_step_thumbnail`, `render_video`, `list_recordings`). The server reuses existing modules (recorder, trace parser, pipeline) and adds a step-grouping analyzer + SRT builder. Runs via `npx recast-mcp`.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (v1.29+), `zod` (v4, peer of MCP SDK), Node.js stdlib (`node:http`, `node:fs`, `node:path`, `node:child_process`)

**Spec:** `docs/specs/2026-04-09-recast-mcp-server-design.md`

**Target repo:** `/Users/thepatriczek/Work/playwright-recast/`

---

## File Structure

```
src/mcp/
  server.ts             — MCP server entry point (stdio transport), tool registration, config loading
  config.ts             — ENV config resolution with validation and clear error messages
  analyzer.ts           — Step grouping algorithm + label generation + thumbnail extraction
  srt-builder.ts        — Generate SRT from steps with voiceover text
  tools/
    record-session.ts   — record_session tool: wrapper around existing recorder
    analyze-trace.ts    — analyze_trace tool: parse trace → grouped steps
    get-thumbnail.ts    — get_step_thumbnail tool: serve JPEG from extracted thumbnails
    render-video.ts     — render_video tool: build pipeline + render to file
    list-recordings.ts  — list_recordings tool: scan directory for trace recordings
```

Modified:
- `package.json` — add `@modelcontextprotocol/sdk`, `zod`, bin entry `recast-mcp`, export `./mcp`
- `tsconfig.json` — no change needed (already includes all of `src/`)

---

### Task 1: Project Setup — Dependencies, Bin Entry, Config Module

**Files:**
- Modify: `package.json`
- Create: `src/mcp/config.ts`

- [ ] **Step 1: Install MCP SDK and Zod**

```bash
cd /Users/thepatriczek/Work/playwright-recast
npm install @modelcontextprotocol/sdk zod
```

- [ ] **Step 2: Add bin entry and export to package.json**

In `package.json`, add to `bin`:
```json
"recast-mcp": "./dist/mcp/server.js"
```

Add to `exports`:
```json
"./mcp": {
  "types": "./dist/mcp/server.d.ts",
  "default": "./dist/mcp/server.js"
}
```

- [ ] **Step 3: Write config module**

Create `src/mcp/config.ts`:

```typescript
import * as path from 'node:path'

export interface RecastMcpConfig {
  /** Working directory for recordings. Default: cwd */
  workDir: string
  /** Default TTS provider */
  ttsProvider: 'openai' | 'elevenlabs' | 'none'
  /** Default voice ID (provider-specific) */
  ttsVoice: string
  /** Default TTS model */
  ttsModel: string
  /** OpenAI API key */
  openaiApiKey: string
  /** ElevenLabs API key */
  elevenlabsApiKey: string
  /** Default output resolution */
  resolution: '720p' | '1080p' | '1440p' | '4k'
  /** Default viewport for recording */
  viewport: { width: number; height: number }
}

export function loadConfig(): RecastMcpConfig {
  const ttsProvider = resolveProvider()

  return {
    workDir: env('RECAST_WORK_DIR', process.cwd()),
    ttsProvider,
    ttsVoice: env('RECAST_TTS_VOICE', ttsProvider === 'elevenlabs' ? 'onwK4e9ZLuTAKqWW03F9' : 'nova'),
    ttsModel: env('RECAST_TTS_MODEL', ttsProvider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'gpt-4o-mini-tts'),
    openaiApiKey: env('OPENAI_API_KEY', ''),
    elevenlabsApiKey: env('ELEVENLABS_API_KEY', ''),
    resolution: env('RECAST_RESOLUTION', '1080p') as RecastMcpConfig['resolution'],
    viewport: {
      width: Number(env('RECAST_VIEWPORT_WIDTH', '1920')),
      height: Number(env('RECAST_VIEWPORT_HEIGHT', '1080')),
    },
  }
}

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

/** Auto-detect TTS provider from available API keys */
function resolveProvider(): RecastMcpConfig['ttsProvider'] {
  const explicit = process.env.RECAST_TTS_PROVIDER
  if (explicit === 'openai' || explicit === 'elevenlabs' || explicit === 'none') return explicit

  if (process.env.OPENAI_API_KEY) return 'openai'
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs'
  return 'none'
}
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: Compiles without errors. `dist/mcp/config.js` exists.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/mcp/config.ts
git commit -m "feat(mcp): add MCP SDK dependency and config module

Config auto-detects TTS provider from available API keys.
All settings configurable via RECAST_* env vars."
```

---

### Task 2: MCP Server Entry Point

**Files:**
- Create: `src/mcp/server.ts`

- [ ] **Step 1: Write server entry point**

Create `src/mcp/server.ts`:

```typescript
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { registerRecordSession } from './tools/record-session.js'
import { registerAnalyzeTrace } from './tools/analyze-trace.js'
import { registerGetThumbnail } from './tools/get-thumbnail.js'
import { registerRenderVideo } from './tools/render-video.js'
import { registerListRecordings } from './tools/list-recordings.js'

const config = loadConfig()

const server = new McpServer(
  { name: 'playwright-recast', version: '0.12.0' },
  {
    instructions: [
      'This server creates demo videos from browser recordings.',
      'Typical workflow: record_session → analyze_trace → (user edits voiceover) → render_video.',
      '',
      'Configuration (via env vars):',
      `  TTS provider: ${config.ttsProvider}${config.ttsProvider === 'none' ? ' (no API key found — set OPENAI_API_KEY or ELEVENLABS_API_KEY)' : ''}`,
      `  Resolution: ${config.resolution}`,
      `  Work dir: ${config.workDir}`,
    ].join('\n'),
  },
)

registerRecordSession(server, config)
registerAnalyzeTrace(server, config)
registerGetThumbnail(server, config)
registerRenderVideo(server, config)
registerListRecordings(server, config)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('playwright-recast MCP server running on stdio')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Create stub tool files so the build passes**

Create five stub files. Each follows this pattern (example for `src/mcp/tools/record-session.ts`):

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'

export function registerRecordSession(_server: McpServer, _config: RecastMcpConfig): void {
  // TODO: implement in Task 4
}
```

Create identical stubs for: `analyze-trace.ts`, `get-thumbnail.ts`, `render-video.ts`, `list-recordings.ts` — changing function name to match (`registerAnalyzeTrace`, `registerGetThumbnail`, `registerRenderVideo`, `registerListRecordings`).

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: Compiles. `dist/mcp/server.js` exists with shebang line.

- [ ] **Step 4: Test server starts and responds to MCP initialize**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node dist/mcp/server.js
```

Expected: JSON response with `serverInfo.name === "playwright-recast"` and `tools` capability.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools/
git commit -m "feat(mcp): add server entry point with tool registration skeleton"
```

---

### Task 3: Step Grouping Analyzer

**Files:**
- Create: `src/mcp/analyzer.ts`
- Test: `src/mcp/__tests__/analyzer.test.ts`

This is the core logic — grouping raw trace actions into logical steps with labels and hidden detection.

- [ ] **Step 1: Write test for hidden step detection**

Create `src/mcp/__tests__/analyzer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { groupActions, type RawAction } from '../analyzer.js'

function action(overrides: Partial<RawAction>): RawAction {
  return {
    callId: `call-${Math.random().toString(36).slice(2, 8)}`,
    method: 'click',
    params: {},
    startTime: 0,
    endTime: 100,
    title: '',
    ...overrides,
  }
}

describe('groupActions', () => {
  it('marks initial goto as hidden', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com' }, title: 'goto' }),
      action({ method: 'click', params: { selector: 'button.submit' }, title: 'click', startTime: 1000, endTime: 1100 }),
    ]
    const steps = groupActions(actions)
    expect(steps[0].hidden).toBe(true)
    expect(steps[1].hidden).toBe(false)
  })

  it('marks login sequence as hidden', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com/login' }, title: 'goto' }),
      action({ method: 'fill', params: { selector: 'input[name="email"]', value: 'user@test.com' }, title: 'fill', startTime: 500, endTime: 600 }),
      action({ method: 'fill', params: { selector: 'input[type="password"]', value: '***' }, title: 'fill', startTime: 700, endTime: 800 }),
      action({ method: 'click', params: { selector: 'button[type="submit"]' }, title: 'click', startTime: 900, endTime: 1000 }),
      action({ method: 'click', params: { selector: 'button.feature' }, title: 'click', startTime: 5000, endTime: 5100 }),
    ]
    const steps = groupActions(actions)
    const hidden = steps.filter((s) => s.hidden)
    const visible = steps.filter((s) => !s.hidden)
    expect(hidden.length).toBeGreaterThanOrEqual(1)
    expect(visible.length).toBeGreaterThanOrEqual(1)
  })

  it('groups click + fill on same area into one step', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.search-input' }, title: 'click', startTime: 0, endTime: 100 }),
      action({ method: 'fill', params: { selector: '.search-input', value: 'report' }, title: 'fill', startTime: 200, endTime: 300 }),
    ]
    const steps = groupActions(actions)
    expect(steps.length).toBe(1)
    expect(steps[0].actionIndices).toEqual([0, 1])
  })

  it('splits actions with >5s time gap into separate steps', () => {
    const actions: RawAction[] = [
      action({ method: 'click', params: { selector: '.btn-a' }, title: 'click', startTime: 0, endTime: 100 }),
      action({ method: 'click', params: { selector: '.btn-b' }, title: 'click', startTime: 10000, endTime: 10100 }),
    ]
    const steps = groupActions(actions)
    expect(steps.length).toBe(2)
  })

  it('generates human-readable labels', () => {
    const actions: RawAction[] = [
      action({ method: 'goto', params: { url: 'https://app.example.com/dashboard' }, title: 'goto', startTime: 0, endTime: 100 }),
      action({ method: 'click', params: { selector: 'button' }, title: 'click "Download"', startTime: 5000, endTime: 5100 }),
    ]
    const steps = groupActions(actions)
    const visible = steps.filter((s) => !s.hidden)
    expect(visible[0].label).toContain('Download')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/thepatriczek/Work/playwright-recast
npx vitest run src/mcp/__tests__/analyzer.test.ts
```

Expected: FAIL — `groupActions` not found.

- [ ] **Step 3: Implement analyzer**

Create `src/mcp/analyzer.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseTrace } from '../parse/trace-parser.js'
import type { TraceAction, FrameReader, ScreencastFrame } from '../types/trace.js'

/** Minimal action shape for grouping (used in tests without full ParsedTrace) */
export interface RawAction {
  callId: string
  method: string
  params: Record<string, unknown>
  startTime: number
  endTime: number
  title: string
  annotations?: Array<{ type: string; description?: string }>
}

export interface AnalyzedStep {
  id: string
  label: string
  hidden: boolean
  actionIndices: number[]
  actions: Array<{
    method: string
    selector?: string
    value?: string
    url?: string
    text?: string
  }>
  startTimeMs: number
  endTimeMs: number
  durationMs: number
  thumbnailSha1?: string
}

export interface AnalysisResult {
  metadata: {
    actionCount: number
    durationMs: number
    viewport: { width: number; height: number }
    url: string
  }
  steps: AnalyzedStep[]
}

// --- Hidden detection ---

const LOGIN_SELECTORS = /password|email|login|username|user.?name|log.?in/i
const COOKIE_SELECTORS = /cookie|consent|accept|gdpr|privacy/i

function isLoginAction(a: RawAction): boolean {
  const selector = String(a.params.selector ?? '')
  return a.method === 'fill' && LOGIN_SELECTORS.test(selector)
}

function isCookieAction(a: RawAction): boolean {
  const selector = String(a.params.selector ?? '')
  return COOKIE_SELECTORS.test(selector)
}

function isHiddenAnnotation(a: RawAction): boolean {
  return a.annotations?.some((ann) => ann.type === 'voiceover-hidden') ?? false
}

// --- Label generation ---

function extractTextFromTitle(title: string): string | undefined {
  const match = title.match(/"([^"]+)"/)
  return match?.[1]
}

function extractPathName(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const last = pathname.split('/').filter(Boolean).pop()
    return last ?? 'page'
  } catch {
    return 'page'
  }
}

function labelForActions(actions: RawAction[], indices: number[]): string {
  const primary = actions[indices[0]!]!
  const selector = String(primary.params.selector ?? '')
  const value = String(primary.params.value ?? '')
  const url = String(primary.params.url ?? '')
  const titleText = extractTextFromTitle(primary.title)

  switch (primary.method) {
    case 'goto':
      return `Navigate to ${extractPathName(url)}`
    case 'fill': {
      const fieldHint = titleText ?? selector.split(/[.#\[\]()>:]+/).pop() ?? 'field'
      return value ? `Type "${value}" in ${fieldHint}` : `Fill in ${fieldHint}`
    }
    case 'selectOption':
      return titleText ? `Select "${titleText}"` : 'Select option'
    case 'click': {
      // Check if next action is fill on same area → combined label
      if (indices.length > 1) {
        const next = actions[indices[1]!]
        if (next?.method === 'fill') {
          const v = String(next.params.value ?? '')
          return v ? `Search for "${v}"` : 'Enter text'
        }
      }
      return titleText ? `Click ${titleText}` : 'Click element'
    }
    default:
      return titleText ?? primary.method
  }
}

// --- Step grouping ---

const TIME_GAP_THRESHOLD_MS = 5000
const USER_METHODS = new Set(['click', 'fill', 'type', 'press', 'selectOption', 'check', 'uncheck', 'goto'])

export function groupActions(rawActions: RawAction[]): AnalyzedStep[] {
  // Filter to user-facing actions only
  const actions = rawActions.filter((a) => USER_METHODS.has(a.method))
  if (actions.length === 0) return []

  // Map each action to its index in the filtered array
  const originalIndices = rawActions.reduce<Map<RawAction, number>>((m, a, i) => {
    m.set(a, i)
    return m
  }, new Map())

  const steps: AnalyzedStep[] = []
  let stepCount = 0

  // Phase 1: detect hidden ranges
  const hiddenFlags = new Array(actions.length).fill(false) as boolean[]

  // First goto is always hidden
  if (actions[0]?.method === 'goto') {
    hiddenFlags[0] = true
  }

  // Login sequences: fill on login-like fields + following submit click
  for (let i = 0; i < actions.length; i++) {
    if (isLoginAction(actions[i]!)) {
      hiddenFlags[i] = true
      // Mark surrounding actions in the login sequence
      if (i > 0 && actions[i - 1]!.method === 'goto') hiddenFlags[i - 1] = true
      if (i + 1 < actions.length && isLoginAction(actions[i + 1]!)) {
        hiddenFlags[i + 1] = true
        if (i + 2 < actions.length && actions[i + 2]!.method === 'click') hiddenFlags[i + 2] = true
      } else if (i + 1 < actions.length && actions[i + 1]!.method === 'click') {
        hiddenFlags[i + 1] = true
      }
    }
    if (isCookieAction(actions[i]!)) hiddenFlags[i] = true
    if (isHiddenAnnotation(actions[i]!)) hiddenFlags[i] = true
  }

  // Phase 2: group visible actions into steps
  let i = 0
  while (i < actions.length) {
    const action = actions[i]!

    // Hidden actions → each becomes its own hidden step (or merge consecutive)
    if (hiddenFlags[i]) {
      const hiddenStart = i
      while (i < actions.length && hiddenFlags[i]) i++
      const hiddenIndices = Array.from({ length: i - hiddenStart }, (_, k) => originalIndices.get(actions[hiddenStart + k]!)!)
      stepCount++
      steps.push({
        id: `step-${stepCount}`,
        label: 'Setup',
        hidden: true,
        actionIndices: hiddenIndices,
        actions: actions.slice(hiddenStart, i).map(summarizeAction),
        startTimeMs: actions[hiddenStart]!.startTime,
        endTimeMs: actions[i - 1]!.endTime,
        durationMs: actions[i - 1]!.endTime - actions[hiddenStart]!.startTime,
      })
      continue
    }

    // Visible action — determine step boundaries
    const stepStart = i
    const indices: number[] = [originalIndices.get(action)!]

    // click + fill on same element → merge
    if (
      action.method === 'click' &&
      i + 1 < actions.length &&
      !hiddenFlags[i + 1] &&
      actions[i + 1]!.method === 'fill' &&
      sameElement(action, actions[i + 1]!)
    ) {
      i++
      indices.push(originalIndices.get(actions[i]!)!)
    }

    i++

    // Check if next action is within time gap
    // (if not, current step ends here)

    stepCount++
    steps.push({
      id: `step-${stepCount}`,
      label: labelForActions(actions, indices.map((idx) => {
        // Find the filtered-array index for this original index
        for (let j = 0; j < actions.length; j++) {
          if (originalIndices.get(actions[j]!) === idx) return j
        }
        return 0
      })),
      hidden: false,
      actionIndices: indices,
      actions: indices.map((idx) => summarizeAction(rawActions[idx]!)),
      startTimeMs: action.startTime,
      endTimeMs: actions[stepStart + indices.length - 1]?.endTime ?? action.endTime,
      durationMs: (actions[stepStart + indices.length - 1]?.endTime ?? action.endTime) - action.startTime,
    })
  }

  return steps
}

function sameElement(a: RawAction, b: RawAction): boolean {
  const sa = String(a.params.selector ?? '')
  const sb = String(b.params.selector ?? '')
  if (!sa || !sb) return false
  return sa === sb || sa.includes(sb) || sb.includes(sa)
}

function summarizeAction(a: RawAction): AnalyzedStep['actions'][number] {
  return {
    method: a.method,
    selector: a.params.selector ? sanitizeSelector(String(a.params.selector)) : undefined,
    value: a.params.value ? maskSensitive(a, String(a.params.value)) : undefined,
    url: a.params.url ? String(a.params.url) : undefined,
    text: extractTextFromTitle(a.title),
  }
}

function sanitizeSelector(selector: string): string {
  // Strip data-testid selectors to keep output clean
  return selector.replace(/\[data-testid="[^"]*"\]/g, '[...]')
}

function maskSensitive(a: RawAction, value: string): string {
  const selector = String(a.params.selector ?? '')
  if (/password/i.test(selector)) return '***'
  return value
}

// --- Full trace analysis (with thumbnails) ---

export async function analyzeTrace(traceDir: string): Promise<AnalysisResult & { dispose: () => void }> {
  const tracePath = path.join(traceDir, 'trace.zip')
  if (!fs.existsSync(tracePath)) {
    throw new Error(`No trace.zip found in ${traceDir}`)
  }

  const trace = await parseTrace(tracePath)
  const actions = trace.actions as unknown as RawAction[]
  const steps = groupActions(actions)

  // Extract thumbnails
  const thumbDir = path.join(traceDir, 'thumbnails')
  fs.mkdirSync(thumbDir, { recursive: true })

  for (const step of steps) {
    const targetTime = step.startTimeMs + 500
    const frame = findClosestFrame(trace.frames, targetTime)
    if (frame) {
      step.thumbnailSha1 = frame.sha1
      const thumbPath = path.join(thumbDir, `${step.id}.jpg`)
      if (!fs.existsSync(thumbPath)) {
        const data = await trace.frameReader.readFrame(frame.sha1)
        fs.writeFileSync(thumbPath, data)
      }
    }
  }

  // Determine initial URL
  const firstGoto = trace.actions.find((a) => a.method === 'goto')
  const url = firstGoto?.params.url ? String(firstGoto.params.url) : ''

  return {
    metadata: {
      actionCount: trace.actions.length,
      durationMs: Number(trace.metadata.endTime) - Number(trace.metadata.startTime),
      viewport: trace.metadata.viewport,
      url,
    },
    steps,
    dispose: () => trace.frameReader.dispose(),
  }
}

function findClosestFrame(frames: ScreencastFrame[], targetTime: number): ScreencastFrame | undefined {
  let best: ScreencastFrame | undefined
  let bestDelta = Infinity
  for (const f of frames) {
    const delta = Math.abs(Number(f.timestamp) - targetTime)
    if (delta < bestDelta) {
      bestDelta = delta
      best = f
    }
  }
  return best
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/mcp/__tests__/analyzer.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/analyzer.ts src/mcp/__tests__/analyzer.test.ts
git commit -m "feat(mcp): add trace analyzer with step grouping and label generation"
```

---

### Task 4: SRT Builder

**Files:**
- Create: `src/mcp/srt-builder.ts`
- Test: `src/mcp/__tests__/srt-builder.test.ts`

- [ ] **Step 1: Write test**

Create `src/mcp/__tests__/srt-builder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { buildSrtFromSteps } from '../srt-builder.js'

describe('buildSrtFromSteps', () => {
  it('generates valid SRT from steps with voiceover', () => {
    const steps = [
      { id: 'step-1', hidden: true, startTimeMs: 0, endTimeMs: 5000, voiceover: undefined },
      { id: 'step-2', hidden: false, startTimeMs: 5000, endTimeMs: 12000, voiceover: 'Open the chat.' },
      { id: 'step-3', hidden: false, startTimeMs: 12000, endTimeMs: 20000, voiceover: 'Ask your question.' },
    ]
    const srt = buildSrtFromSteps(steps)
    expect(srt).toContain('1\n00:00:05,000 --> 00:00:12,000\nOpen the chat.')
    expect(srt).toContain('2\n00:00:12,000 --> 00:00:20,000\nAsk your question.')
    expect(srt).not.toContain('step-1') // hidden step excluded
  })

  it('extends last entry by 5s', () => {
    const steps = [
      { id: 'step-1', hidden: false, startTimeMs: 0, endTimeMs: 3000, voiceover: 'Only step.' },
    ]
    const srt = buildSrtFromSteps(steps)
    expect(srt).toContain('00:00:00,000 --> 00:00:08,000')
  })

  it('skips steps without voiceover text', () => {
    const steps = [
      { id: 'step-1', hidden: false, startTimeMs: 0, endTimeMs: 5000, voiceover: '' },
      { id: 'step-2', hidden: false, startTimeMs: 5000, endTimeMs: 10000, voiceover: 'Has text.' },
    ]
    const srt = buildSrtFromSteps(steps)
    expect(srt).not.toContain('00:00:00')
    expect(srt).toContain('Has text.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/mcp/__tests__/srt-builder.test.ts
```

Expected: FAIL — `buildSrtFromSteps` not found.

- [ ] **Step 3: Implement SRT builder**

Create `src/mcp/srt-builder.ts`:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import { writeSrt } from '../subtitles/srt-writer.js'
import type { SubtitleEntry } from '../types/subtitle.js'

interface StepInput {
  id: string
  hidden: boolean
  startTimeMs: number
  endTimeMs: number
  voiceover?: string
}

const LAST_ENTRY_EXTENSION_MS = 5000

export function buildSrtFromSteps(steps: StepInput[]): string {
  const entries: SubtitleEntry[] = []
  let index = 1

  const visibleWithVoiceover = steps.filter((s) => !s.hidden && s.voiceover && s.voiceover.trim().length > 0)

  for (let i = 0; i < visibleWithVoiceover.length; i++) {
    const step = visibleWithVoiceover[i]!
    const isLast = i === visibleWithVoiceover.length - 1

    entries.push({
      index: index++,
      startMs: step.startTimeMs,
      endMs: isLast ? step.startTimeMs + LAST_ENTRY_EXTENSION_MS : step.endTimeMs,
      text: step.voiceover!.trim(),
    })
  }

  return writeSrt(entries)
}

export function writeSrtFile(traceDir: string, steps: StepInput[]): string {
  const srt = buildSrtFromSteps(steps)
  const srtPath = path.join(traceDir, 'voiceover.srt')
  fs.writeFileSync(srtPath, srt, 'utf-8')
  return srtPath
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/mcp/__tests__/srt-builder.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/srt-builder.ts src/mcp/__tests__/srt-builder.test.ts
git commit -m "feat(mcp): add SRT builder for voiceover steps"
```

---

### Task 5: record_session Tool

**Files:**
- Modify: `src/mcp/tools/record-session.ts`

- [ ] **Step 1: Implement record_session tool**

Replace `src/mcp/tools/record-session.ts`:

```typescript
import { z } from 'zod'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'
import { record } from '../../studio/recorder.js'

export function registerRecordSession(server: McpServer, config: RecastMcpConfig): void {
  server.registerTool(
    'record_session',
    {
      title: 'Record Browser Session',
      description: [
        'Opens a browser at the given URL for interactive recording.',
        'The user navigates the app to demo a feature.',
        'When done, they click "Resume" in the Playwright Inspector.',
        'Returns trace metadata. Use analyze_trace next to process the recording.',
      ].join(' '),
      inputSchema: z.object({
        url: z.string().url().describe('URL to open in the browser'),
        outputDir: z.string().optional().describe('Output directory for trace files. Default: .recast-studio/'),
        viewportWidth: z.number().int().positive().optional().describe('Browser viewport width. Default: 1920'),
        viewportHeight: z.number().int().positive().optional().describe('Browser viewport height. Default: 1080'),
        ignoreHttpsErrors: z.boolean().optional().describe('Ignore HTTPS certificate errors. Default: false'),
        loadStorage: z.string().optional().describe('Path to Playwright storage state JSON for pre-authenticated sessions'),
      }),
    },
    async ({ url, outputDir, viewportWidth, viewportHeight, ignoreHttpsErrors, loadStorage }) => {
      const outDir = path.resolve(outputDir ?? path.join(config.workDir, '.recast-studio'))
      const vw = viewportWidth ?? config.viewport.width
      const vh = viewportHeight ?? config.viewport.height

      try {
        const result = await record(url, outDir, {
          viewport: { width: vw, height: vh },
          ignoreHttpsErrors: ignoreHttpsErrors ?? false,
          loadStorage,
        })

        if (result.actionCount === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Recording completed but no interactions were detected. The user may have closed the browser without interacting.' }],
            isError: true,
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              traceDir: result.outputDir,
              tracePath: result.tracePath,
              videoPath: result.videoPath,
              actionCount: result.actionCount,
              durationMs: result.durationMs,
            }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Recording failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/record-session.ts
git commit -m "feat(mcp): implement record_session tool"
```

---

### Task 6: analyze_trace Tool

**Files:**
- Modify: `src/mcp/tools/analyze-trace.ts`

- [ ] **Step 1: Implement analyze_trace tool**

Replace `src/mcp/tools/analyze-trace.ts`:

```typescript
import { z } from 'zod'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'
import { analyzeTrace } from '../analyzer.js'

export function registerAnalyzeTrace(server: McpServer, config: RecastMcpConfig): void {
  server.registerTool(
    'analyze_trace',
    {
      title: 'Analyze Recording',
      description: [
        'Parses a Playwright trace and returns structured steps with action descriptions and timing.',
        'Auto-detects hidden steps (login, setup, cookie consent).',
        'Use the returned steps to write voiceover text, then pass to render_video.',
        'Each step has a thumbnailPath — use get_step_thumbnail to show screenshots to the user.',
      ].join(' '),
      inputSchema: z.object({
        traceDir: z.string().describe('Directory containing trace.zip (returned by record_session)'),
      }),
    },
    async ({ traceDir }) => {
      const resolvedDir = path.resolve(traceDir)

      try {
        const { metadata, steps, dispose } = await analyzeTrace(resolvedDir)
        dispose() // Release zip file handle

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ metadata, steps }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Analysis failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/analyze-trace.ts
git commit -m "feat(mcp): implement analyze_trace tool"
```

---

### Task 7: get_step_thumbnail Tool

**Files:**
- Modify: `src/mcp/tools/get-thumbnail.ts`

- [ ] **Step 1: Implement get_step_thumbnail tool**

Replace `src/mcp/tools/get-thumbnail.ts`:

```typescript
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'

export function registerGetThumbnail(server: McpServer, _config: RecastMcpConfig): void {
  server.registerTool(
    'get_step_thumbnail',
    {
      title: 'Get Step Screenshot',
      description: 'Returns a screenshot image for a specific step. Use after analyze_trace to show the user what each step looks like.',
      inputSchema: z.object({
        traceDir: z.string().describe('Directory containing trace.zip'),
        stepId: z.string().describe('Step ID from analyze_trace (e.g. "step-1")'),
      }),
    },
    async ({ traceDir, stepId }) => {
      const thumbPath = path.join(path.resolve(traceDir), 'thumbnails', `${stepId}.jpg`)

      if (!fs.existsSync(thumbPath)) {
        return {
          content: [{ type: 'text' as const, text: `No thumbnail found for ${stepId}. Run analyze_trace first.` }],
          isError: true,
        }
      }

      const data = fs.readFileSync(thumbPath)

      return {
        content: [{
          type: 'image' as const,
          data: data.toString('base64'),
          mimeType: 'image/jpeg',
        }],
      }
    },
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/get-thumbnail.ts
git commit -m "feat(mcp): implement get_step_thumbnail tool with image response"
```

---

### Task 8: render_video Tool

**Files:**
- Modify: `src/mcp/tools/render-video.ts`

- [ ] **Step 1: Implement render_video tool**

Replace `src/mcp/tools/render-video.ts`:

```typescript
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'
import { Pipeline as Recast } from '../../pipeline/pipeline.js'
import { OpenAIProvider } from '../../voiceover/providers/openai.js'
import { ElevenLabsProvider } from '../../voiceover/providers/elevenlabs.js'
import { writeSrtFile } from '../srt-builder.js'
import type { TraceAction } from '../../types/trace.js'
import type { TtsProvider } from '../../types/voiceover.js'

const stepSchema = z.object({
  id: z.string().describe('Step ID from analyze_trace'),
  hidden: z.boolean().describe('Whether to hide this step from the video'),
  voiceover: z.string().optional().describe('Voiceover text for this step (visible steps only)'),
})

const settingsSchema = z.object({
  ttsProvider: z.enum(['openai', 'elevenlabs', 'none']).optional().describe('TTS provider. Default: auto-detected from env'),
  voice: z.string().optional().describe('Voice ID. Default: provider-dependent'),
  model: z.string().optional().describe('TTS model ID. Default: provider-dependent'),
  speedIdle: z.number().optional().describe('Speed multiplier during idle periods. Default: 3.0'),
  speedAction: z.number().optional().describe('Speed during user actions. Default: 1.0'),
  speedNetwork: z.number().optional().describe('Speed during network waits. Default: 2.0'),
  format: z.enum(['mp4', 'webm']).optional().describe('Output format. Default: mp4'),
  resolution: z.enum(['720p', '1080p', '1440p', '4k']).optional().describe('Output resolution. Default from config'),
  burnSubtitles: z.boolean().optional().describe('Burn subtitles into video. Default: true'),
  cursorOverlay: z.boolean().optional().describe('Show animated cursor. Default: true'),
  clickEffect: z.boolean().optional().describe('Show click ripple effect. Default: true'),
  autoZoom: z.boolean().optional().describe('Auto-zoom to interaction targets. Default: true'),
  outputPath: z.string().optional().describe('Output file path. Default: <traceDir>/demo.mp4'),
}).optional()

export function registerRenderVideo(server: McpServer, config: RecastMcpConfig): void {
  server.registerTool(
    'render_video',
    {
      title: 'Render Demo Video',
      description: [
        'Renders a polished demo video from a trace recording with voiceover, subtitles, and visual effects.',
        'Requires steps from analyze_trace with voiceover text filled in.',
        'The agent should write voiceover text collaboratively with the user before calling this.',
      ].join(' '),
      inputSchema: z.object({
        traceDir: z.string().describe('Directory containing trace.zip'),
        steps: z.array(stepSchema).describe('Steps with voiceover text (from analyze_trace, edited by agent)'),
        settings: settingsSchema,
      }),
    },
    async ({ traceDir, steps, settings }) => {
      const resolvedDir = path.resolve(traceDir)
      const s = settings ?? {}

      try {
        // Write SRT from steps
        const srtPath = writeSrtFile(resolvedDir, steps)

        // Build hidden action set by re-analyzing the trace to map step IDs → action indices → callIds
        const hiddenStepIds = new Set(steps.filter((st) => st.hidden).map((st) => st.id))
        const { analyzeTrace } = await import('../analyzer.js')
        const { steps: analyzedSteps, dispose: disposeAnalysis } = await analyzeTrace(resolvedDir)
        disposeAnalysis()

        const hiddenActionIndices = new Set<number>()
        for (const as of analyzedSteps) {
          if (hiddenStepIds.has(as.id)) {
            for (const idx of as.actionIndices) hiddenActionIndices.add(idx)
          }
        }

        // Get callIds for hidden actions (hideSteps predicate receives TraceAction, not index)
        const { parseTrace } = await import('../../parse/trace-parser.js')
        const trace = await parseTrace(path.join(resolvedDir, 'trace.zip'))
        const hiddenCallIds = new Set<string>()
        for (const idx of hiddenActionIndices) {
          if (trace.actions[idx]) hiddenCallIds.add(trace.actions[idx]!.callId)
        }
        trace.frameReader.dispose()

        // Build pipeline
        let pipeline = Recast.from(resolvedDir).parse()
        pipeline = pipeline.hideSteps((action: TraceAction) => hiddenCallIds.has(action.callId))

        // Speed
        pipeline = pipeline.speedUp({
          duringIdle: s.speedIdle ?? 3.0,
          duringUserAction: s.speedAction ?? 1.0,
          duringNetworkWait: s.speedNetwork ?? 2.0,
        })

        // Subtitles
        pipeline = pipeline.subtitlesFromSrt(srtPath)
        pipeline = pipeline.textProcessing({ builtins: true })

        // Visual effects
        if (s.autoZoom !== false) pipeline = pipeline.autoZoom({ inputLevel: 1.2 })
        if (s.cursorOverlay !== false) pipeline = pipeline.cursorOverlay()
        if (s.clickEffect !== false) pipeline = pipeline.clickEffect({ sound: true })

        // TTS
        const provider = s.ttsProvider ?? config.ttsProvider
        if (provider !== 'none') {
          const tts = createTtsProvider(provider, s, config)
          if (tts) pipeline = pipeline.voiceover(tts)
        }

        // Render
        const format = s.format ?? 'mp4'
        const ext = format === 'webm' ? '.webm' : '.mp4'
        const outputPath = s.outputPath ?? path.join(resolvedDir, `demo${ext}`)

        pipeline = pipeline.render({
          format,
          resolution: s.resolution ?? config.resolution,
          burnSubtitles: s.burnSubtitles !== false,
          subtitleStyle: {
            fontFamily: 'Arial',
            fontSize: 48,
            primaryColor: '#1a1a1a',
            backgroundColor: '#FFFFFF',
            backgroundOpacity: 0.75,
            padding: 20,
            bold: true,
            position: 'bottom',
            marginVertical: 50,
            marginHorizontal: 100,
            chunkOptions: { maxCharsPerLine: 55 },
          },
        })

        await pipeline.toFile(outputPath)

        // Collect result info
        const stat = fs.statSync(outputPath)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              videoPath: outputPath,
              srtPath,
              fileSizeBytes: stat.size,
              fileSizeMB: (stat.size / 1024 / 1024).toFixed(1),
            }, null, 2),
          }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Render failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        }
      }
    },
  )
}

function createTtsProvider(
  provider: 'openai' | 'elevenlabs',
  settings: Record<string, unknown>,
  config: RecastMcpConfig,
): TtsProvider | null {
  if (provider === 'openai') {
    if (!config.openaiApiKey) {
      console.error('Warning: OPENAI_API_KEY not set, skipping voiceover')
      return null
    }
    return OpenAIProvider({
      apiKey: config.openaiApiKey,
      voice: (settings.voice as string) ?? config.ttsVoice,
      model: (settings.model as string) ?? config.ttsModel,
      speed: 1.2,
    })
  }

  if (provider === 'elevenlabs') {
    if (!config.elevenlabsApiKey) {
      console.error('Warning: ELEVENLABS_API_KEY not set, skipping voiceover')
      return null
    }
    return ElevenLabsProvider({
      apiKey: config.elevenlabsApiKey,
      voiceId: (settings.voice as string) ?? config.ttsVoice,
      modelId: (settings.model as string) ?? config.ttsModel,
    })
  }

  return null
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/render-video.ts
git commit -m "feat(mcp): implement render_video tool with full pipeline"
```

---

### Task 9: list_recordings Tool

**Files:**
- Modify: `src/mcp/tools/list-recordings.ts`

- [ ] **Step 1: Implement list_recordings tool**

Replace `src/mcp/tools/list-recordings.ts`:

```typescript
import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RecastMcpConfig } from '../config.js'

export function registerListRecordings(server: McpServer, config: RecastMcpConfig): void {
  server.registerTool(
    'list_recordings',
    {
      title: 'List Recordings',
      description: 'Lists available trace recordings in a directory. Useful to find previous recordings for re-processing.',
      inputSchema: z.object({
        dir: z.string().optional().describe('Directory to scan. Default: current working directory'),
      }),
    },
    async ({ dir }) => {
      const scanDir = path.resolve(dir ?? config.workDir)

      if (!fs.existsSync(scanDir)) {
        return {
          content: [{ type: 'text' as const, text: `Directory not found: ${scanDir}` }],
          isError: true,
        }
      }

      const entries = fs.readdirSync(scanDir, { withFileTypes: true })
      const recordings: Array<{
        traceDir: string
        hasTrace: boolean
        hasVideo: boolean
        hasSrt: boolean
        hasRendered: boolean
        modifiedAt: string
      }> = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const subdir = path.join(scanDir, entry.name)
        const files = fs.readdirSync(subdir)
        const hasTrace = files.includes('trace.zip')
        if (!hasTrace) continue

        recordings.push({
          traceDir: subdir,
          hasTrace: true,
          hasVideo: files.some((f) => f.endsWith('.webm')),
          hasSrt: files.includes('subtitles.srt') || files.includes('voiceover.srt'),
          hasRendered: files.some((f) => f.startsWith('demo.') || f.startsWith('recast-final.')),
          modifiedAt: fs.statSync(path.join(subdir, 'trace.zip')).mtime.toISOString(),
        })
      }

      // Also check if scanDir itself contains trace.zip
      const ownFiles = fs.readdirSync(scanDir)
      if (ownFiles.includes('trace.zip')) {
        recordings.unshift({
          traceDir: scanDir,
          hasTrace: true,
          hasVideo: ownFiles.some((f) => f.endsWith('.webm')),
          hasSrt: ownFiles.includes('subtitles.srt') || ownFiles.includes('voiceover.srt'),
          hasRendered: ownFiles.some((f) => f.startsWith('demo.') || f.startsWith('recast-final.')),
          modifiedAt: fs.statSync(path.join(scanDir, 'trace.zip')).mtime.toISOString(),
        })
      }

      recordings.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())

      if (recordings.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No recordings found in ${scanDir}. Use record_session to create one.` }],
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ recordings }, null, 2),
        }],
      }
    },
  )
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: Compiles.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/tools/list-recordings.ts
git commit -m "feat(mcp): implement list_recordings tool"
```

---

### Task 10: End-to-End Integration Test

**Files:**
- Create: `src/mcp/__tests__/server.integration.test.ts`

- [ ] **Step 1: Write integration test for MCP protocol**

Create `src/mcp/__tests__/server.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

const SERVER_PATH = path.resolve(__dirname, '../../../dist/mcp/server.js')

function mcpCall(method: string, params: Record<string, unknown> = {}): unknown {
  // Send initialize + method call via stdin
  const init = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  })

  const initialized = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })

  const toolsList = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })

  const input = [init, initialized, toolsList].join('\n')

  const output = execFileSync('node', [SERVER_PATH], {
    input,
    timeout: 10_000,
    env: { ...process.env, RECAST_TTS_PROVIDER: 'none' },
  }).toString()

  // Parse JSONRPC responses (may be multiple lines)
  const lines = output.trim().split('\n').filter(Boolean)
  return lines.map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
}

describe('MCP server', () => {
  it('lists all 5 tools', () => {
    const responses = mcpCall('tools/list') as any[]
    const toolsResponse = responses.find((r: any) => r.id === 2)
    expect(toolsResponse).toBeDefined()

    const toolNames = toolsResponse.result.tools.map((t: any) => t.name).sort()
    expect(toolNames).toEqual([
      'analyze_trace',
      'get_step_thumbnail',
      'list_recordings',
      'record_session',
      'render_video',
    ])
  })
})
```

- [ ] **Step 2: Build and run the test**

```bash
npm run build && npx vitest run src/mcp/__tests__/server.integration.test.ts
```

Expected: PASS — server responds with 5 tools.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/__tests__/server.integration.test.ts
git commit -m "test(mcp): add integration test verifying MCP protocol and tool listing"
```

---

### Task 11: Local MCP Configuration for Testing

**Files:**
- Create or modify: `.mcp.json` in playwright-recast repo root (for local Claude Code testing)

- [ ] **Step 1: Create .mcp.json for local testing**

Create `.mcp.json` in `/Users/thepatriczek/Work/playwright-recast/`:

```json
{
  "mcpServers": {
    "recast": {
      "command": "node",
      "args": ["./dist/mcp/server.js"],
      "env": {
        "RECAST_WORK_DIR": ".",
        "RECAST_RESOLUTION": "1080p"
      }
    }
  }
}
```

Note: API keys (OPENAI_API_KEY, ELEVENLABS_API_KEY) should come from the user's shell environment or be added to the env block. Do NOT commit API keys.

- [ ] **Step 2: Add .mcp.json to .gitignore if it contains secrets**

Check `.gitignore` — if `.mcp.json` is not already listed and might contain API keys, add it. If it only has safe config (no keys), it can be committed as a template.

- [ ] **Step 3: Build the server**

```bash
npm run build
```

- [ ] **Step 4: Test interactively with Claude Code**

Open Claude Code in the playwright-recast directory. The MCP server should auto-connect. Ask Claude to:
1. `list_recordings` — should work, listing any existing recordings
2. If there's a trace available, test `analyze_trace` on it

- [ ] **Step 5: Commit**

```bash
git add .mcp.json
git commit -m "chore(mcp): add local MCP config for testing"
```

---

### Task 12: Plugin MCP Integration

**Files (in the plugin repo, NOT playwright-recast):**
- Create: `.mcp.json` at plugin root
- Modify: `.claude-plugin/plugin.json` to reference hooks

The playwright-recast Claude Code plugin lives separately from the library. After the MCP server is published in playwright-recast, the plugin needs to declare it so it auto-starts when the plugin is enabled.

- [ ] **Step 1: Add .mcp.json to plugin**

Create `.mcp.json` at plugin root:

```json
{
  "mcpServers": {
    "recast": {
      "command": "npx",
      "args": ["recast-mcp"],
      "env": {
        "RECAST_WORK_DIR": "."
      }
    }
  }
}
```

This uses `npx` so it always gets the latest version. ENV vars like `OPENAI_API_KEY` and `ELEVENLABS_API_KEY` come from the user's shell environment.

- [ ] **Step 2: Update plugin.json to reference hooks**

Add to `.claude-plugin/plugin.json`:
```json
"hooks": "./hooks/hooks.json",
"mcpServers": "./.mcp.json"
```

- [ ] **Step 3: Commit**

---

### Task 13: Plugin Hooks for Workflow Guidance

**Files (in the plugin repo):**
- Create: `hooks/hooks.json`
- Create: `hooks/pre-render-validate.sh`

- [ ] **Step 1: Create hooks.json**

Create `hooks/hooks.json`:

```json
{
  "description": "Workflow guidance hooks for playwright-recast demo video creation",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__recast__record_session",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Recording complete. Now call analyze_trace with the returned traceDir to detect steps and generate labels. After analysis, write voiceover text for each visible step using marketing tone: focus on client value, not UI mechanics."
          }
        ]
      },
      {
        "matcher": "mcp__recast__analyze_trace",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Trace analyzed. Now write voiceover text for each visible step. Guidelines:\n- Focus on client value (what it saves, simplifies, speeds up), NOT UI descriptions\n- Never say 'the user clicks' — say what the action achieves\n- Keep each step to 1-2 sentences, short-medium length\n- Use professional, natural tone suitable for TTS\n- First step: hook the viewer (name the problem being solved)\n- Last step: soft call to action\n- Present all steps to the user for review before calling render_video"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "mcp__recast__render_video",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/pre-render-validate.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Create pre-render validation script (crossplatform — Node.js)**

Create `hooks/pre-render-validate.js`:

```javascript
#!/usr/bin/env node
// Crossplatform pre-render validation hook (Linux, Mac, Windows)
// Validates that all visible steps have voiceover text before rendering.

const input = process.env.TOOL_INPUT
if (!input) {
  // No input — allow (non-blocking)
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
  process.exit(0)
}

try {
  const data = JSON.parse(input)
  const steps = data.steps || []
  const missing = steps
    .filter(s => !s.hidden && (!s.voiceover || !s.voiceover.trim()))
    .map(s => s.id)

  if (missing.length > 0) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Missing voiceover text for visible steps: ${missing.join(', ')}. Please write voiceover for all visible steps before rendering.`,
      },
    }))
  } else {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
  }
} catch {
  // Parse error — allow and let MCP server handle validation
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
}
```

Update the hook reference in `hooks/hooks.json` to use `node` instead of shell:

```json
"PreToolUse": [
  {
    "matcher": "mcp__recast__render_video",
    "hooks": [
      {
        "type": "command",
        "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/pre-render-validate.js",
        "timeout": 5
      }
    ]
  }
]
```

- [ ] **Step 3: Commit**

```bash
git add hooks/ .mcp.json .claude-plugin/plugin.json
git commit -m "feat: add MCP server integration and workflow hooks"
```

---

## Verification Plan

After all tasks are complete:

1. **Unit tests pass:** `npx vitest run src/mcp/`
2. **Build succeeds:** `npm run build`
3. **MCP protocol works:** Server starts via `node dist/mcp/server.js`, responds to initialize + tools/list
4. **npx works:** `npx recast-mcp` starts the server (test after npm link or local install)
5. **Claude Code integration:** Configure `.mcp.json`, have Claude list recordings and analyze a trace
6. **Full flow (manual):** Record → analyze → write voiceover with Claude → render video

## ENV Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `RECAST_WORK_DIR` | `process.cwd()` | Working directory for recordings |
| `RECAST_TTS_PROVIDER` | auto-detect | `openai`, `elevenlabs`, or `none` |
| `RECAST_TTS_VOICE` | provider default | Voice ID |
| `RECAST_TTS_MODEL` | provider default | TTS model ID |
| `RECAST_RESOLUTION` | `1080p` | Default output resolution |
| `RECAST_VIEWPORT_WIDTH` | `1920` | Recording viewport width |
| `RECAST_VIEWPORT_HEIGHT` | `1080` | Recording viewport height |
| `OPENAI_API_KEY` | — | OpenAI API key for TTS |
| `ELEVENLABS_API_KEY` | — | ElevenLabs API key for TTS |
