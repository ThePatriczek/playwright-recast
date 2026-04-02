# Text Highlight Design

## Context

playwright-recast already supports visual effects for mouse interactions (click ripple, cursor overlay). Users need a way to draw attention to specific text on screen during demo videos — e.g., highlighting a contract title, a price, or a key label. This feature adds a marker/highlighter effect (like a yellow highlighter pen) that sweeps over text and fades out.

**Two phases:**
- **Phase 1**: Config-driven (`highlight-config.json` with manual coordinates) — works on existing traces without re-running tests
- **Phase 2**: Helper-driven (`highlight(locator)` in tests) — captures exact bounding boxes during test execution

Both phases share the same pipeline stage, generator, and renderer.

## Architecture

### Data Flow

**Phase 1 (config-driven):**
```
highlight-config.json → .enrichHighlightFromConfig(steps) → Pipeline Stage → Renderer
```

**Phase 2 (helper-driven, future):**
```
Test step → Annotation → Report Writer → Pipeline Stage → Renderer
```

### Phase 1: Config File

**File**: `highlight-config.json` (alongside `zoom-config.json` in test results)

```json
[
  {
    "stepIndex": 5,
    "x": 300,
    "y": 150,
    "width": 200,
    "height": 30,
    "color": "#FFEB3B",
    "opacity": 0.35,
    "label": "optional description for debugging"
  },
  {
    "stepIndex": 8,
    "x": 450,
    "y": 320,
    "width": 150,
    "height": 28,
    "color": "#4CAF50"
  }
]
```

Coordinates are viewport pixels (1920×1080). `stepIndex` maps to the BDD step — the highlight appears when that step starts in the video.

Pattern follows `zoom-config.json` which already exists for manual zoom overrides.

### Phase 2: Helper Function (future)

**File**: `src/helpers.ts`

```typescript
export async function highlight(
  locator: Locator,
  options?: HighlightOptions
): Promise<void>
```

Internally:
1. `locator.boundingBox()` — captures element position and dimensions
2. `Date.now()` — trace timestamp
3. Stores as annotation: `{ type: 'highlight', description: JSON.stringify({ x, y, width, height, time, ...options }) }`

```typescript
interface HighlightOptions {
  color?: string          // hex '#RRGGBB', default: '#FFEB3B' (yellow)
  opacity?: number        // 0.0–1.0, default: 0.35
  duration?: number       // visibility duration in ms, default: 3000
  fadeOut?: number         // fade out duration in ms, default: 500
  swipeDuration?: number  // swipe animation duration in ms, default: 300
  padding?: {
    x?: number            // horizontal padding in px, default: 4
    y?: number            // vertical padding in px, default: 2
  }
}
```

### Pipeline Stages

Two new stage types:

**1. `enrichHighlightFromConfig`** — loads highlight positions from config (Phase 1):

```typescript
// In stages.ts:
| { type: 'enrichHighlightFromConfig'; steps: HighlightConfigStep[] }

// Pipeline method:
.enrichHighlightFromConfig(steps: HighlightConfigStep[])
```

**2. `textHighlight`** — configures global highlight defaults:

```typescript
// In stages.ts:
| { type: 'textHighlight'; config: TextHighlightConfig }

// Pipeline method:
.textHighlight(config?: TextHighlightConfig)
```

```typescript
interface TextHighlightConfig {
  color?: string          // default color for all highlights, '#FFEB3B'
  opacity?: number        // default: 0.35
  duration?: number       // default: 3000ms
  fadeOut?: number         // default: 500ms
  swipeDuration?: number  // default: 300ms
  padding?: { x?: number; y?: number }
  filter?: (highlight: HighlightEvent) => boolean
}

interface HighlightConfigStep {
  stepIndex: number       // BDD step index
  x: number               // viewport px
  y: number               // viewport px
  width: number           // viewport px
  height: number          // viewport px
  color?: string          // override per-highlight
  opacity?: number
  duration?: number
  fadeOut?: number
  swipeDuration?: number
  label?: string          // debugging description
}
```

**Ordering**: After `clickEffect`, before `autoZoom` — so zoom correctly frames highlighted areas.

### Executor Processing

In `src/pipeline/executor.ts`:

**`enrichHighlightFromConfig` case:**
1. Maps config steps to trace steps by `stepIndex`
2. Gets step start time from parsed trace
3. Stores raw highlight data on state

**`textHighlight` case:**
1. Reads highlight data (from config enrichment or future helper annotations)
2. Remaps timestamps through `state.speedMapped.timeRemap()`
3. Calculates actual display duration (respects page navigations — highlight disappears if page changes)
4. Merges per-highlight options with global defaults
5. Stores `state.highlightEvents: HighlightEvent[]`

```typescript
interface HighlightEvent {
  x: number               // viewport px
  y: number               // viewport px
  width: number           // viewport px
  height: number          // viewport px
  videoTimeMs: number     // after speed remap
  endTimeMs: number       // auto-calculated (min of duration, next navigation)
  color: string
  opacity: number
  swipeDuration: number   // ms
  fadeOut: number          // ms
}
```

### Highlight Generator

**New file**: `src/text-highlight/highlight-generator.ts`

Generates a pre-animated marker clip via ffmpeg lavfi (same pattern as `src/click-effect/ripple-generator.ts`):

**Animation profile:**
1. **Phase 1 — Swipe** (0 → swipeDuration): Rectangle progressively reveals left to right
   - `crop=w='min(iw,iw*t/{swipeSec})':h=ih:x=0:y=0`
2. **Phase 2 — Hold** (swipeDuration → duration): Full rectangle visible
3. **Phase 3 — Fade out** (duration → duration+fadeOut): Alpha fade
   - `fade=t=out:st={durationSec}:d={fadeOutSec}:alpha=1`

**ffmpeg filter chain:**
```
color=c={color}@{opacity}:s={width}x{height}:d={totalDuration} →
  format=rgba →
  crop (animated swipe reveal) →
  fade (out at end) →
  output.mov (ProRes 4444 with alpha)
```

One clip per highlight (different dimensions). Clips can be cached when dimensions + color match.

**Scale factor**: All dimensions relative to source viewport (1920×1080), scaled by `srcHeight / viewportHeight` (same approach as click effects).

### Renderer Integration

**File**: `src/renderer.ts`, new function `renderWithHighlights()`

For each `HighlightEvent`:
1. Generate marker clip with padded dimensions × scale factor
2. `movie='marker_{i}.mov',setpts=PTS+{startTimeSec}/TB,format=rgba[h{i}]`
3. `[prev][h{i}]overlay={scaledX-padX}:{scaledY-padY}:eof_action=pass[v{i}]`

Rendering order within the pipeline: after click effects, before zoom.

### Demo App Integration

**Pipeline** (`recast-pipeline.ts`):
```typescript
// Load config
const highlightConfig = loadJsonIfExists(path.join(testDir, 'highlight-config.json'))

// In pipeline:
.clickEffect({ sound: true })
.enrichHighlightFromConfig(highlightConfig ?? [])  // NEW
.textHighlight()                                     // NEW
.voiceover(cachedProvider)
```

Pattern matches how `zoom-config.json` is already loaded and fed to `.enrichZoomFromReport()`.

## Files to Create/Modify

### playwright-recast (library)

| File | Action | Purpose |
|------|--------|---------|
| `src/text-highlight/types.ts` | Create | `HighlightOptions`, `TextHighlightConfig`, `HighlightEvent`, `HighlightConfigStep` |
| `src/text-highlight/defaults.ts` | Create | Default config values, `resolveTextHighlightConfig()` |
| `src/text-highlight/highlight-generator.ts` | Create | ffmpeg lavfi marker clip generation (swipe + fade) |
| `src/text-highlight/index.ts` | Create | Barrel export |
| `src/pipeline/stages.ts` | Modify | Add `enrichHighlightFromConfig` + `textHighlight` stage descriptors |
| `src/pipeline/pipeline.ts` | Modify | Add `.enrichHighlightFromConfig()` + `.textHighlight()` methods |
| `src/pipeline/executor.ts` | Modify | Add both cases in `runStages()` |
| `src/renderer.ts` | Modify | Add `renderWithHighlights()`, integrate in rendering order |
| `src/index.ts` | Modify | Export types |

### cdx-daemon (demo app)

| File | Action | Purpose |
|------|--------|---------|
| `frontend/apps/demo/src/recast-pipeline.ts` | Modify | Load `highlight-config.json`, add pipeline stages |
| `frontend/apps/demo/test-results/.../highlight-config.json` | Create | Initial highlight config for testing |

### Future (Phase 2)

| File | Action | Purpose |
|------|--------|---------|
| `src/helpers.ts` | Modify | Add `highlight()` helper function |
| `frontend/apps/demo/src/demo-report-writer.ts` | Modify | Collect highlight annotations |
| `frontend/apps/demo/src/fixtures.ts` | Modify | Re-export `highlight` |

## Verification

1. **Quick test**: Create `highlight-config.json` in cached test results, run recast pipeline, verify marker overlay appears in output video
2. **Visual check**: Correct positioning, swipe animation left→right, fade out
3. **Speed remap**: Highlight times should be correct after speed processing
4. **Edge cases**:
   - Multiple highlights in same step — should layer correctly
   - Highlight near viewport edges — padding should not exceed bounds
   - Highlight during fast-forwarded section — should appear at correct remapped time
