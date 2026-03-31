# Click Effect Stage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a click highlighting stage to playwright-recast that renders animated ripple effects and optional click sounds at click positions in the output video.

**Architecture:** New pipeline stage `.clickEffect(config)` extracts click actions from the parsed trace, remaps timestamps through speed processing, and passes `ClickEvent[]` to the renderer. The renderer generates a transparent ripple clip via ffmpeg lavfi, overlays it at each click position/time using `movie` + `setpts`, and optionally mixes a click sound track into the audio.

**Tech Stack:** ffmpeg (geq filter for ripple generation, movie + overlay for compositing, amix for audio), TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types/click-effect.ts` | Create | `ClickEffectConfig` and `ClickEvent` interfaces |
| `src/click-effect/ripple-generator.ts` | Create | Generate transparent ripple clip via ffmpeg lavfi+geq |
| `src/click-effect/sound-track.ts` | Create | Build click sound audio track (silence + sounds at timestamps) |
| `src/click-effect/defaults.ts` | Create | Default config values, default click sound generation |
| `src/pipeline/stages.ts` | Modify | Add `clickEffect` to `StageDescriptor` union |
| `src/pipeline/pipeline.ts` | Modify | Add `.clickEffect()` builder method |
| `src/pipeline/executor.ts` | Modify | Add `clickEffect` case — extract clicks, remap timestamps, store on state |
| `src/render/renderer.ts` | Modify | Add click overlay phase (between zoom and padding) + audio mixing |
| `src/cli.ts` | Modify | Add `--click-effect`, `--click-effect-config`, `--click-sound` flags |
| `src/index.ts` | Modify | Export new types |
| `tests/unit/click-effect/defaults.test.ts` | Create | Test default config resolution |
| `tests/unit/click-effect/ripple-generator.test.ts` | Create | Test ripple clip generation |
| `tests/unit/click-effect/sound-track.test.ts` | Create | Test sound track assembly |
| `tests/unit/pipeline/pipeline.test.ts` | Modify | Test `.clickEffect()` in pipeline chain |

---

### Task 1: Type Definitions

**Files:**
- Create: `src/types/click-effect.ts`

- [ ] **Step 1: Write the type file**

```typescript
// src/types/click-effect.ts
import type { TraceAction } from './trace.js'

/** Configuration for the click effect pipeline stage */
export interface ClickEffectConfig {
  /** Ripple color as hex '#RRGGBB'. Default: '#3B82F6' (blue) */
  color?: string
  /** Ripple opacity 0.0–1.0. Default: 0.5 */
  opacity?: number
  /** Max ripple radius in px, relative to 1080p. Default: 30 */
  radius?: number
  /** Ripple animation duration in ms. Default: 400 */
  duration?: number
  /** Path to click sound file, or `true` for generated default. Default: undefined (no sound) */
  sound?: string | true
  /** Click sound volume 0.0–1.0. Default: 0.8 */
  soundVolume?: number
  /** Filter which click actions to highlight. Default: all clicks with coordinates */
  filter?: (action: TraceAction) => boolean
}

/** A processed click event ready for the renderer */
export interface ClickEvent {
  /** X coordinate in viewport pixels */
  x: number
  /** Y coordinate in viewport pixels */
  y: number
  /** Timestamp in video time (ms), after speed remapping */
  videoTimeMs: number
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors related to click-effect types

- [ ] **Step 3: Commit**

```bash
git add src/types/click-effect.ts
git commit -m "feat(click-effect): add ClickEffectConfig and ClickEvent types"
```

---

### Task 2: Default Config & Sound Generation

**Files:**
- Create: `src/click-effect/defaults.ts`
- Test: `tests/unit/click-effect/defaults.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/click-effect/defaults.test.ts
import { describe, it, expect } from 'vitest'
import { resolveClickEffectConfig, DEFAULT_CLICK_EFFECT } from '../../../src/click-effect/defaults'

describe('resolveClickEffectConfig', () => {
  it('returns all defaults when no config provided', () => {
    const resolved = resolveClickEffectConfig({})
    expect(resolved.color).toBe('#3B82F6')
    expect(resolved.opacity).toBe(0.5)
    expect(resolved.radius).toBe(30)
    expect(resolved.duration).toBe(400)
    expect(resolved.soundVolume).toBe(0.8)
  })

  it('overrides specific values', () => {
    const resolved = resolveClickEffectConfig({ color: '#FF0000', radius: 50 })
    expect(resolved.color).toBe('#FF0000')
    expect(resolved.radius).toBe(50)
    expect(resolved.opacity).toBe(0.5) // still default
  })

  it('preserves filter function', () => {
    const filter = () => true
    const resolved = resolveClickEffectConfig({ filter })
    expect(resolved.filter).toBe(filter)
  })
})

describe('DEFAULT_CLICK_EFFECT', () => {
  it('has all required fields', () => {
    expect(DEFAULT_CLICK_EFFECT.color).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.opacity).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.radius).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.duration).toBeDefined()
    expect(DEFAULT_CLICK_EFFECT.soundVolume).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/click-effect/defaults.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/click-effect/defaults.ts
import type { ClickEffectConfig } from '../types/click-effect.js'

export const DEFAULT_CLICK_EFFECT = {
  color: '#3B82F6',
  opacity: 0.5,
  radius: 30,
  duration: 400,
  soundVolume: 0.8,
} as const

/** Merge user config with defaults */
export function resolveClickEffectConfig(
  config: ClickEffectConfig,
): Required<Pick<ClickEffectConfig, 'color' | 'opacity' | 'radius' | 'duration' | 'soundVolume'>> & ClickEffectConfig {
  return {
    ...config,
    color: config.color ?? DEFAULT_CLICK_EFFECT.color,
    opacity: config.opacity ?? DEFAULT_CLICK_EFFECT.opacity,
    radius: config.radius ?? DEFAULT_CLICK_EFFECT.radius,
    duration: config.duration ?? DEFAULT_CLICK_EFFECT.duration,
    soundVolume: config.soundVolume ?? DEFAULT_CLICK_EFFECT.soundVolume,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/click-effect/defaults.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/click-effect/defaults.ts tests/unit/click-effect/defaults.test.ts
git commit -m "feat(click-effect): add default config resolution"
```

---

### Task 3: Ripple Clip Generator

**Files:**
- Create: `src/click-effect/ripple-generator.ts`
- Test: `tests/unit/click-effect/ripple-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/click-effect/ripple-generator.test.ts
import { describe, it, expect } from 'vitest'
import { buildRippleArgs } from '../../../src/click-effect/ripple-generator'

describe('buildRippleArgs', () => {
  it('produces valid ffmpeg args for default config', () => {
    const args = buildRippleArgs({
      color: '#3B82F6',
      opacity: 0.5,
      radius: 30,
      duration: 400,
      outputPath: '/tmp/ripple.mov',
      scaleFactor: 1.0,
    })

    expect(args).toContain('-f')
    expect(args).toContain('lavfi')
    expect(args.some(a => a.includes('geq'))).toBe(true)
    expect(args.some(a => a.includes('format=rgba'))).toBe(true)
    expect(args).toContain('/tmp/ripple.mov')
  })

  it('scales radius by scaleFactor', () => {
    const args1x = buildRippleArgs({
      color: '#FF0000',
      opacity: 0.6,
      radius: 30,
      duration: 400,
      outputPath: '/tmp/ripple.mov',
      scaleFactor: 1.0,
    })
    const args2x = buildRippleArgs({
      color: '#FF0000',
      opacity: 0.6,
      radius: 30,
      duration: 400,
      outputPath: '/tmp/ripple.mov',
      scaleFactor: 2.0,
    })

    // The 2x version should have a larger canvas (size in the lavfi input)
    const getSize = (args: string[]) => {
      const lavfi = args.find(a => a.includes('color='))!
      const match = lavfi.match(/s=(\d+)x(\d+)/)
      return match ? Number(match[1]) : 0
    }
    expect(getSize(args2x)).toBe(getSize(args1x) * 2)
  })

  it('embeds correct color components in geq', () => {
    const args = buildRippleArgs({
      color: '#FF8800',
      opacity: 0.5,
      radius: 30,
      duration: 400,
      outputPath: '/tmp/ripple.mov',
      scaleFactor: 1.0,
    })
    const vf = args.find(a => a.includes('geq'))!
    // Red=255, Green=136, Blue=0
    expect(vf).toContain('r=255')
    expect(vf).toContain('g=136')
    expect(vf).toContain('b=0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/click-effect/ripple-generator.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/click-effect/ripple-generator.ts
import { execFileSync } from 'node:child_process'

export interface RippleArgs {
  color: string     // hex '#RRGGBB'
  opacity: number   // 0.0–1.0
  radius: number    // px at 1080p
  duration: number  // ms
  outputPath: string
  scaleFactor: number // e.g., 2.0 for 4K source from 1080p-relative
}

/** Parse hex color to RGB components */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  }
}

/**
 * Build ffmpeg args to generate a transparent ripple clip.
 *
 * Creates a short video with an expanding circle that fades out.
 * Uses geq on a small canvas (2*radius x 2*radius) for performance.
 */
export function buildRippleArgs(opts: RippleArgs): string[] {
  const { r, g, b } = hexToRgb(opts.color)
  const scaledRadius = Math.round(opts.radius * opts.scaleFactor)
  const size = scaledRadius * 2
  // Ensure even dimensions for codec compatibility
  const s = size % 2 === 0 ? size : size + 1
  const center = s / 2
  const durSec = (opts.duration / 1000).toFixed(3)
  const alpha = Math.round(opts.opacity * 255)

  // geq alpha expression:
  // - dist = distance from center
  // - currentRadius = maxRadius * (t / duration) — grows linearly
  // - fade = (1 - t/duration) — overall opacity decreases
  // - edge = soft falloff near circle boundary (3px gradient)
  // - result = alpha * fade * edge if inside circle, else 0
  //
  // In ffmpeg geq, all expressions use \ to escape commas within the filter.
  const alphaExpr = [
    `if(lte(hypot(X-${center}\\,Y-${center})`,
    `\\,${scaledRadius}*(t/${durSec}))`,
    `\\,${alpha}*(1-t/${durSec})*max(0\\,1-max(0\\,hypot(X-${center}\\,Y-${center})-${scaledRadius}*(t/${durSec})+3)/3)`,
    `\\,0)`,
  ].join('')

  const lavfiInput = `color=c=black@0:s=${s}x${s}:d=${durSec}:r=30,format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${alphaExpr}'`

  return [
    '-y',
    '-f', 'lavfi', '-i', lavfiInput,
    '-c:v', 'png',  // PNG codec preserves alpha in MOV container
    opts.outputPath,
  ]
}

/**
 * Generate a transparent ripple clip to a temp file.
 * Returns the path to the generated clip.
 */
export function generateRippleClip(opts: RippleArgs): string {
  const args = buildRippleArgs(opts)
  execFileSync('ffmpeg', args, { stdio: 'pipe' })
  return opts.outputPath
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/click-effect/ripple-generator.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/click-effect/ripple-generator.ts tests/unit/click-effect/ripple-generator.test.ts
git commit -m "feat(click-effect): add ripple clip generator"
```

---

### Task 4: Click Sound Track Builder

**Files:**
- Create: `src/click-effect/sound-track.ts`
- Test: `tests/unit/click-effect/sound-track.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/click-effect/sound-track.test.ts
import { describe, it, expect } from 'vitest'
import { buildClickSoundArgs, buildDefaultSoundArgs } from '../../../src/click-effect/sound-track'

describe('buildDefaultSoundArgs', () => {
  it('generates a synthetic click sound with sine wave', () => {
    const args = buildDefaultSoundArgs('/tmp/click.mp3')
    expect(args).toContain('-f')
    expect(args).toContain('lavfi')
    expect(args.some(a => a.includes('sine'))).toBe(true)
    expect(args.some(a => a.includes('afade'))).toBe(true)
    expect(args).toContain('/tmp/click.mp3')
  })
})

describe('buildClickSoundArgs', () => {
  it('creates concat demuxer args for clicks at given timestamps', () => {
    const clicks = [
      { videoTimeMs: 1000 },
      { videoTimeMs: 5000 },
      { videoTimeMs: 8000 },
    ]
    const result = buildClickSoundArgs({
      clicks,
      soundPath: '/tmp/click.mp3',
      soundDurationMs: 50,
      outputPath: '/tmp/click-track.mp3',
      volume: 0.8,
    })

    // Should produce silence segments between clicks
    expect(result.silenceDurations).toHaveLength(3) // silence before each click
    expect(result.silenceDurations[0]).toBe(1000) // 0 to 1000ms
    expect(result.silenceDurations[1]).toBe(3950) // 1050 to 5000ms (1000+50=1050)
    expect(result.silenceDurations[2]).toBe(2950) // 5050 to 8000ms
  })

  it('handles single click at t=0', () => {
    const result = buildClickSoundArgs({
      clicks: [{ videoTimeMs: 0 }],
      soundPath: '/tmp/click.mp3',
      soundDurationMs: 50,
      outputPath: '/tmp/click-track.mp3',
      volume: 0.8,
    })
    expect(result.silenceDurations).toHaveLength(1)
    expect(result.silenceDurations[0]).toBe(0) // no silence before first click
  })

  it('skips clicks too close together (within sound duration)', () => {
    const result = buildClickSoundArgs({
      clicks: [
        { videoTimeMs: 1000 },
        { videoTimeMs: 1020 }, // only 20ms after previous, sound is 50ms
        { videoTimeMs: 3000 },
      ],
      soundPath: '/tmp/click.mp3',
      soundDurationMs: 50,
      outputPath: '/tmp/click-track.mp3',
      volume: 0.8,
    })
    // Second click should be skipped (overlaps with first)
    expect(result.silenceDurations).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/click-effect/sound-track.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write the implementation**

```typescript
// src/click-effect/sound-track.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Build ffmpeg args to generate a synthetic click sound.
 * Short sine burst at 4kHz, ~30ms, with quick fade in/out.
 */
export function buildDefaultSoundArgs(outputPath: string): string[] {
  return [
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=4000:duration=0.03,aformat=sample_rates=44100',
    '-af', 'afade=t=in:d=0.005,afade=t=out:st=0.01:d=0.02',
    '-c:a', 'libmp3lame', '-q:a', '2',
    outputPath,
  ]
}

/** Generate the default click sound to a file */
export function generateDefaultSound(outputPath: string): void {
  execFileSync('ffmpeg', buildDefaultSoundArgs(outputPath), { stdio: 'pipe' })
}

export interface ClickSoundInput {
  clicks: Array<{ videoTimeMs: number }>
  soundPath: string
  soundDurationMs: number
  outputPath: string
  volume: number
}

export interface ClickSoundPlan {
  /** Silence duration (ms) before each click sound */
  silenceDurations: number[]
  /** Filtered clicks (overlapping ones removed) */
  filteredClicks: Array<{ videoTimeMs: number }>
}

/**
 * Plan the click sound track: compute silence durations between clicks,
 * remove overlapping clicks.
 */
export function buildClickSoundArgs(input: ClickSoundInput): ClickSoundPlan {
  const sorted = [...input.clicks].sort((a, b) => a.videoTimeMs - b.videoTimeMs)

  const filtered: Array<{ videoTimeMs: number }> = []
  const silenceDurations: number[] = []
  let cursor = 0

  for (const click of sorted) {
    // Skip if this click overlaps with the previous sound
    if (filtered.length > 0 && click.videoTimeMs < cursor) {
      continue
    }

    const silenceMs = Math.max(0, click.videoTimeMs - cursor)
    silenceDurations.push(silenceMs)
    filtered.push(click)
    cursor = click.videoTimeMs + input.soundDurationMs
  }

  return { silenceDurations, filteredClicks: filtered }
}

/**
 * Generate the click sound audio track.
 * Concatenates silence + click sound segments using ffmpeg concat demuxer.
 */
export function generateClickSoundTrack(
  input: ClickSoundInput,
  tmpDir: string,
): string {
  const plan = buildClickSoundArgs(input)
  if (plan.filteredClicks.length === 0) return ''

  const segmentFiles: string[] = []

  for (let i = 0; i < plan.filteredClicks.length; i++) {
    const silenceMs = plan.silenceDurations[i]!

    // Add silence before this click
    if (silenceMs > 0) {
      const silencePath = path.join(tmpDir, `click-silence-${i}.mp3`)
      execFileSync('ffmpeg', [
        '-y', '-f', 'lavfi', '-i',
        `anullsrc=r=44100:cl=mono,atrim=0:${(silenceMs / 1000).toFixed(3)}`,
        '-c:a', 'libmp3lame', '-q:a', '2', silencePath,
      ], { stdio: 'pipe' })
      segmentFiles.push(silencePath)
    }

    // Add click sound (with volume adjustment)
    if (Math.abs(input.volume - 1.0) > 0.01) {
      const volPath = path.join(tmpDir, `click-vol-${i}.mp3`)
      execFileSync('ffmpeg', [
        '-y', '-i', input.soundPath,
        '-af', `volume=${input.volume}`,
        '-c:a', 'libmp3lame', '-q:a', '2', volPath,
      ], { stdio: 'pipe' })
      segmentFiles.push(volPath)
    } else {
      segmentFiles.push(input.soundPath)
    }
  }

  // Concat all segments
  const concatList = path.join(tmpDir, 'click-concat.txt')
  fs.writeFileSync(concatList, segmentFiles.map(f => `file '${f}'`).join('\n'))

  execFileSync('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', concatList,
    '-c:a', 'libmp3lame', '-q:a', '2',
    input.outputPath,
  ], { stdio: 'pipe' })

  return input.outputPath
}

/** Get audio duration in ms using ffprobe */
export function getAudioDurationMs(audioPath: string): number {
  const out = execFileSync('ffprobe', [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath,
  ]).toString().trim()
  return Math.round(Number(out) * 1000)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/click-effect/sound-track.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/click-effect/sound-track.ts tests/unit/click-effect/sound-track.test.ts
git commit -m "feat(click-effect): add click sound track builder"
```

---

### Task 5: Pipeline Stage & Builder Method

**Files:**
- Modify: `src/pipeline/stages.ts:1-38`
- Modify: `src/pipeline/pipeline.ts:1-7,91-103`
- Modify: `tests/unit/pipeline/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the end of `tests/unit/pipeline/pipeline.test.ts`:

```typescript
  it('adds clickEffect stage with config', () => {
    const config = { color: '#FF0000', radius: 50, sound: true as const }
    const pipeline = Recast.from('./trace.zip')
      .parse()
      .clickEffect(config)
      .render()

    const stages = pipeline.getStages()
    const clickStage = stages.find(s => s.type === 'clickEffect')
    expect(clickStage).toBeDefined()
    if (clickStage?.type === 'clickEffect') {
      expect(clickStage.config.color).toBe('#FF0000')
      expect(clickStage.config.radius).toBe(50)
      expect(clickStage.config.sound).toBe(true)
    }
  })

  it('clickEffect defaults to empty config', () => {
    const pipeline = Recast.from('./trace.zip').parse().clickEffect()
    const stages = pipeline.getStages()
    const clickStage = stages.find(s => s.type === 'clickEffect')
    expect(clickStage).toBeDefined()
    if (clickStage?.type === 'clickEffect') {
      expect(clickStage.config).toEqual({})
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/pipeline/pipeline.test.ts`
Expected: FAIL — `.clickEffect` is not a function

- [ ] **Step 3: Add stage descriptor to stages.ts**

In `src/pipeline/stages.ts`, add the import and union member.

Add to imports (line 1):
```typescript
import type { ClickEffectConfig } from '../types/click-effect.js'
```

Add to `StageDescriptor` union (after `enrichZoomFromReport` line, before `voiceover` line):
```typescript
  | { type: 'clickEffect'; config: ClickEffectConfig }
```

- [ ] **Step 4: Add builder method to pipeline.ts**

In `src/pipeline/pipeline.ts`, add the import:
```typescript
import type { ClickEffectConfig } from '../types/click-effect.js'
```

Add method after `enrichZoomFromReport()` (before `voiceover()`):
```typescript
  /**
   * Add click highlighting effects to the video.
   * Renders animated ripple at each click position with optional sound.
   * Requires parse() first (needs trace actions with cursor positions).
   */
  clickEffect(config: ClickEffectConfig = {}): Pipeline {
    return this.addStage({ type: 'clickEffect', config })
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/Work/playwright-recast && npx vitest run tests/unit/pipeline/pipeline.test.ts`
Expected: All tests PASS (including 2 new ones)

- [ ] **Step 6: Type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/stages.ts src/pipeline/pipeline.ts tests/unit/pipeline/pipeline.test.ts
git commit -m "feat(click-effect): add clickEffect pipeline stage and builder method"
```

---

### Task 6: Executor — Extract Click Events

**Files:**
- Modify: `src/pipeline/executor.ts:1-30,280-391`
- Modify: `src/render/renderer.ts:58-63`

- [ ] **Step 1: Add ClickEvent to RenderableTrace**

In `src/render/renderer.ts`, add import:
```typescript
import type { ClickEvent } from '../types/click-effect.js'
```

Add to `RenderableTrace` interface (after `speedSegments` field):
```typescript
  clickEvents?: ClickEvent[]
```

- [ ] **Step 2: Add clickEffect case to executor**

In `src/pipeline/executor.ts`, add imports:
```typescript
import type { ClickEvent } from '../types/click-effect.js'
import { resolveClickEffectConfig } from '../click-effect/defaults.js'
```

Add `clickEvents?: ClickEvent[]` and `clickEffectConfig?: ReturnType<typeof resolveClickEffectConfig>` to `PipelineState` type.

Add to `traceWithVideo` in `execute()`:
```typescript
clickEvents: state.clickEvents,
clickEffectConfig: state.clickEffectConfig,
```

Wait — `clickEffectConfig` isn't on `RenderableTrace`. We need to pass it. Add to `RenderableTrace`:
```typescript
  clickEffectConfig?: { color: string; opacity: number; radius: number; duration: number; soundVolume: number; sound?: string | true }
```

Add the `clickEffect` case after `autoZoom` (before `voiceover`):

```typescript
        case 'clickEffect': {
          if (!state.parsed) throw new Error('clickEffect() requires parse() first')

          const config = resolveClickEffectConfig(stage.config)
          const CLICK_METHODS = new Set(['click', 'selectOption'])

          // Extract click actions with coordinates
          let clickActions = state.parsed.actions.filter(
            (a) => CLICK_METHODS.has(a.method) && a.point,
          )

          // Apply user filter if configured
          if (stage.config.filter) {
            clickActions = clickActions.filter(stage.config.filter)
          }

          // Base time for video-relative timestamps
          const firstFrameTime = state.parsed.frames.length > 0
            ? (state.parsed.frames[0]!.timestamp as number)
            : (state.parsed.metadata.startTime as number)

          // Remap to video time
          const clickEvents: ClickEvent[] = clickActions.map((action) => {
            const traceTimeMs = action.startTime as number
            let videoTimeMs: number

            if (state.speedMapped && state.speedMapped.speedSegments.length > 0) {
              // Remap through speed processing
              const recPageId = state.parsed!.frames.length > 0
                ? state.parsed!.frames[state.parsed!.frames.length - 1]!.pageId : undefined
              const recFrames = recPageId
                ? state.parsed!.frames.filter(f => f.pageId === recPageId) : state.parsed!.frames
              const firstRecFrameMs = recFrames[0]?.timestamp as number ?? firstFrameTime
              const videoStartOutput = state.speedMapped.timeRemap(toMonotonic(firstRecFrameMs))
              videoTimeMs = state.speedMapped.timeRemap(toMonotonic(traceTimeMs)) - videoStartOutput
            } else {
              videoTimeMs = traceTimeMs - firstFrameTime
            }

            return {
              x: action.point!.x,
              y: action.point!.y,
              videoTimeMs: Math.max(0, Math.round(videoTimeMs)),
            }
          })

          state.clickEvents = clickEvents
          state.clickEffectConfig = config
          console.log(`  clickEffect: ${clickEvents.length} clicks detected`)
          break
        }
```

- [ ] **Step 3: Wire clickEvents into traceWithVideo**

In `executor.ts`, update the `traceWithVideo` construction (around line 61-67) to include:
```typescript
    const traceWithVideo: RenderableTrace = {
      ...renderableTrace,
      sourceVideoPath: state.sourceVideoPath,
      subtitles: state.subtitled?.subtitles,
      voiceover: state.voiceovered?.voiceover,
      speedSegments: state.speedMapped?.speedSegments,
      clickEvents: state.clickEvents,
      clickEffectConfig: state.clickEffectConfig,
    }
```

- [ ] **Step 4: Type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/executor.ts src/render/renderer.ts
git commit -m "feat(click-effect): add executor case to extract and remap click events"
```

---

### Task 7: Renderer — Click Ripple Overlay

**Files:**
- Modify: `src/render/renderer.ts:374-505`

This is the core rendering change. Adds a new phase between zoom (Phase 3) and padding (Phase 4).

- [ ] **Step 1: Add a `renderWithClickEffects` function**

Add after the `renderWithZoom` function in `renderer.ts`:

```typescript
/**
 * Apply click ripple overlays to the video.
 * For each click event, overlays a pre-generated transparent ripple clip
 * at the click position/time using ffmpeg movie filter + overlay.
 */
function renderWithClickEffects(
  sourceVideo: string,
  clickEvents: ClickEvent[],
  config: { color: string; opacity: number; radius: number; duration: number },
  tmpDir: string,
): string {
  if (clickEvents.length === 0) return sourceVideo

  const srcRes = probeResolution(sourceVideo)
  // Scale factor: radius is relative to 1080p
  const scaleFactor = srcRes.height / 1080

  // Generate the ripple clip once
  const ripplePath = path.join(tmpDir, 'ripple.mov')
  generateRippleClip({
    color: config.color,
    opacity: config.opacity,
    radius: config.radius,
    duration: config.duration,
    outputPath: ripplePath,
    scaleFactor,
  })

  const scaledRadius = Math.round(config.radius * scaleFactor)
  const rippleSize = scaledRadius * 2
  const s = rippleSize % 2 === 0 ? rippleSize : rippleSize + 1
  const halfSize = s / 2
  const durSec = (config.duration / 1000).toFixed(3)

  // Build filter_complex with movie sources for each click.
  // Each movie instance creates an independent stream positioned at the click time.
  const filterParts: string[] = []
  let prevLabel = '0:v'

  for (let i = 0; i < clickEvents.length; i++) {
    const click = clickEvents[i]!
    // Scale click coordinates to source resolution
    // Trace coordinates are in viewport pixels; source video may be at devicePixelRatio > 1
    const scaleX = srcRes.width / 1920  // assuming 1920 viewport (will be refined)
    const scaleY = srcRes.height / 1080
    const cx = Math.round(click.x * scaleX)
    const cy = Math.round(click.y * scaleY)
    const timeSec = (click.videoTimeMs / 1000).toFixed(3)
    const outLabel = `v${i}`
    const rippleLabel = `r${i}`

    // movie filter: read ripple, shift PTS to click time
    const escapedPath = ripplePath.replace(/'/g, "'\\''").replace(/\\/g, '\\\\')
    filterParts.push(
      `movie='${escapedPath}',setpts=PTS+${timeSec}/TB,format=rgba[${rippleLabel}]`,
    )
    // Overlay at click position (centered)
    const ox = Math.max(0, cx - Math.round(halfSize))
    const oy = Math.max(0, cy - Math.round(halfSize))
    filterParts.push(
      `[${prevLabel}][${rippleLabel}]overlay=${ox}:${oy}:eof_action=pass:format=auto[${outLabel}]`,
    )
    prevLabel = outLabel
  }

  const outputPath = path.join(tmpDir, 'click-overlay.mp4')
  ffmpeg([
    '-y', '-i', sourceVideo,
    '-filter_complex', filterParts.join(';'),
    '-map', `[${prevLabel}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-an',
    outputPath,
  ])

  return outputPath
}
```

- [ ] **Step 2: Add imports at top of renderer.ts**

```typescript
import type { ClickEvent } from '../types/click-effect.js'
import { generateRippleClip } from '../click-effect/ripple-generator.js'
```

- [ ] **Step 3: Wire into renderVideo — add Phase 3.5**

In `renderVideo()`, after the zoom phase (Phase 3) and before the padding phase (Phase 4), add:

```typescript
  // Phase 3.5: Apply click effect overlays
  const hasClickEffects = trace.clickEvents && trace.clickEvents.length > 0 && trace.clickEffectConfig
  if (hasClickEffects) {
    videoInput = renderWithClickEffects(
      videoInput,
      trace.clickEvents!,
      trace.clickEffectConfig!,
      tmpDir,
    )
  }
```

- [ ] **Step 4: Type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/render/renderer.ts
git commit -m "feat(click-effect): add ripple overlay rendering phase"
```

---

### Task 8: Renderer — Click Sound Audio Mixing

**Files:**
- Modify: `src/render/renderer.ts:374-505`

- [ ] **Step 1: Add sound track generation and mixing**

Add imports:
```typescript
import {
  generateDefaultSound,
  generateClickSoundTrack,
  getAudioDurationMs as getClickAudioDurationMs,
} from '../click-effect/sound-track.js'
```

In `renderVideo()`, after the click overlay phase and before Phase 4 (padding), add click sound track generation:

```typescript
  // Phase 3.7: Generate click sound track if configured
  let clickSoundTrackPath: string | undefined
  if (hasClickEffects && trace.clickEffectConfig!.sound) {
    const soundConfig = trace.clickEffectConfig!
    let soundPath: string

    if (soundConfig.sound === true) {
      // Generate default synthetic click sound
      soundPath = path.join(tmpDir, 'default-click.mp3')
      generateDefaultSound(soundPath)
    } else {
      soundPath = soundConfig.sound as string
    }

    const soundDurationMs = getClickAudioDurationMs(soundPath)

    clickSoundTrackPath = generateClickSoundTrack(
      {
        clicks: trace.clickEvents!,
        soundPath,
        soundDurationMs,
        outputPath: path.join(tmpDir, 'click-sound-track.mp3'),
        volume: soundConfig.soundVolume,
      },
      tmpDir,
    )
  }
```

Then modify Phase 5 (final encode) to mix click sound with existing audio:

```typescript
  // If we have both voiceover and click sound, mix them first
  let audioTrackPath: string | undefined
  if (hasAudio && trace.voiceover) {
    audioTrackPath = trace.voiceover.audioTrackPath
  }

  if (clickSoundTrackPath && audioTrackPath) {
    // Mix click sound into voiceover track
    const mixedPath = path.join(tmpDir, 'mixed-audio.mp3')
    ffmpeg([
      '-y', '-i', audioTrackPath, '-i', clickSoundTrackPath,
      '-filter_complex', 'amix=inputs=2:duration=longest:dropout_transition=0',
      '-c:a', 'libmp3lame', '-q:a', '2', mixedPath,
    ])
    audioTrackPath = mixedPath
  } else if (clickSoundTrackPath && !audioTrackPath) {
    audioTrackPath = clickSoundTrackPath
  }
```

Update the Phase 5 ffmpeg args to use `audioTrackPath` variable instead of directly referencing `trace.voiceover.audioTrackPath`:

Replace the audio input line:
```typescript
  if (audioTrackPath) {
    ffmpegArgs.push('-i', audioTrackPath)
  }
```

And the audio codec line:
```typescript
  if (audioTrackPath) {
    ffmpegArgs.push('-c:a', 'aac', '-b:a', '128k')
  }
```

Also update tpad calculation to consider click sound duration:
```typescript
  let tpadDuration = 0
  const effectiveAudioDur = audioTrackPath
    ? (hasAudio && trace.voiceover ? trace.voiceover.totalDurationMs / 1000 : 0)
    : 0
  if (effectiveAudioDur > 0) {
    const videoDur = getVideoDuration(videoInput)
    if (effectiveAudioDur > videoDur + 0.5) {
      tpadDuration = effectiveAudioDur - videoDur + 1.0
    }
  }
```

- [ ] **Step 2: Type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/render/renderer.ts
git commit -m "feat(click-effect): add click sound track mixing in renderer"
```

---

### Task 9: CLI Flags

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add CLI flags to help text**

In `src/cli.ts`, add to the help string (after `--burn-subs` line):

```
      --click-effect       Enable click highlighting with default config
      --click-effect-config <path>  JSON config for click effects
      --click-sound <path> Custom click sound audio file
```

- [ ] **Step 2: Add to parseArgs options**

Add to the `options` object:

```typescript
      'click-effect': { type: 'boolean', default: false },
      'click-effect-config': { type: 'string' },
      'click-sound': { type: 'string' },
```

- [ ] **Step 3: Add pipeline integration**

After the text processing section and before the voiceover section, add:

```typescript
  // Click effect
  if (values['click-effect-config']) {
    const raw = fs.readFileSync(values['click-effect-config'], 'utf-8')
    const clickConfig = JSON.parse(raw)
    if (values['click-sound']) {
      clickConfig.sound = values['click-sound']
    }
    pipeline = pipeline.clickEffect(clickConfig)
  } else if (values['click-effect']) {
    const clickConfig: Record<string, unknown> = {}
    if (values['click-sound']) {
      clickConfig.sound = values['click-sound']
    }
    pipeline = pipeline.clickEffect(clickConfig)
  } else if (values['click-sound']) {
    pipeline = pipeline.clickEffect({ sound: values['click-sound'] })
  }
```

- [ ] **Step 4: Type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(click-effect): add --click-effect CLI flags"
```

---

### Task 10: Public API Exports

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add exports**

Add to `src/index.ts` after the `TextProcessingConfig` exports:

```typescript
// Click effect
export type { ClickEffectConfig, ClickEvent } from './types/click-effect.js'
```

- [ ] **Step 2: Type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(click-effect): export ClickEffectConfig and ClickEvent types"
```

---

### Task 11: Full Type Check & Test Suite

- [ ] **Step 1: Run full type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all tests**

Run: `cd ~/Work/playwright-recast && npx vitest run`
Expected: All tests pass (existing + new click-effect tests)

- [ ] **Step 3: Fix any issues**

If there are type errors or test failures, fix them and re-run.

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A && git commit -m "fix: resolve type/test issues from click-effect integration"
```

---

### Task 12: Coordinate Scaling Refinement

**Files:**
- Modify: `src/render/renderer.ts` (renderWithClickEffects)
- Modify: `src/pipeline/executor.ts` (clickEffect case)

The click coordinates from the trace are in **viewport pixels** (e.g., 1920x1080). The source video may be at a different resolution (e.g., 3840x2160 with devicePixelRatio=2). The renderer needs to scale coordinates correctly.

- [ ] **Step 1: Pass viewport info to renderer**

In `executor.ts`, include viewport in click events or pass it separately. Simplest: store viewport on RenderableTrace.

Add to `RenderableTrace` in `renderer.ts`:
```typescript
  viewport?: { width: number; height: number }
```

In `executor.ts`, add to `traceWithVideo`:
```typescript
      viewport: state.parsed?.metadata.viewport,
```

- [ ] **Step 2: Use viewport for scaling in renderWithClickEffects**

Replace the hardcoded `1920`/`1080` scale calculation:

```typescript
  const viewport = trace.viewport ?? { width: 1920, height: 1080 }
  // ... inside the loop:
  const scaleX = srcRes.width / viewport.width
  const scaleY = srcRes.height / viewport.height
```

Wait — `renderWithClickEffects` doesn't receive `trace`, it receives individual args. Add viewport parameter:

```typescript
function renderWithClickEffects(
  sourceVideo: string,
  clickEvents: ClickEvent[],
  config: { color: string; opacity: number; radius: number; duration: number },
  viewport: { width: number; height: number },
  tmpDir: string,
): string {
```

Update the call site in `renderVideo`:
```typescript
    videoInput = renderWithClickEffects(
      videoInput,
      trace.clickEvents!,
      trace.clickEffectConfig!,
      trace.metadata.viewport,
      tmpDir,
    )
```

- [ ] **Step 3: Type check**

Run: `cd ~/Work/playwright-recast && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/render/renderer.ts src/pipeline/executor.ts
git commit -m "fix(click-effect): use viewport dimensions for coordinate scaling"
```

---

### Task 13: Manual Integration Test

This task verifies the full pipeline end-to-end using an existing trace.

- [ ] **Step 1: Test CLI with click effect**

```bash
cd ~/Work/playwright-recast
npx tsx src/cli.ts -i /path/to/trace-dir --click-effect -o /tmp/click-test.mp4
```

Expected: Video renders with visible ripple effects at click positions

- [ ] **Step 2: Test CLI with click effect + sound**

```bash
npx tsx src/cli.ts -i /path/to/trace-dir --click-effect --click-sound /path/to/click.mp3 -o /tmp/click-test-sound.mp4
```

Expected: Video with ripple effects AND audible click sounds

- [ ] **Step 3: Test programmatic API**

```typescript
import { Recast } from './src/index'

await Recast
  .from('/path/to/trace-dir')
  .parse()
  .speedUp({ duringIdle: 3.0 })
  .clickEffect({ color: '#FF6B35', radius: 40, sound: true })
  .render({ format: 'mp4' })
  .toFile('/tmp/click-api-test.mp4')
```

- [ ] **Step 4: Verify and fix any rendering issues**

Check the output videos for:
- Ripple appears at correct click positions
- Ripple timing matches click moments in the video
- Ripple animation is visible (expanding circle, fading opacity)
- Video is not cropped or distorted outside of ripple areas
- Click sounds (if enabled) are audible at correct times
- Audio mixing with voiceover works correctly (no clipping/distortion)

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix(click-effect): rendering adjustments from integration test"
```
