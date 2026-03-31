# Click Effect Stage — Design Spec

## Context

Demo videos from playwright-recast show user interactions but clicks are invisible — the viewer can't tell when/where a click happened. Adding visual click highlighting (ripple animation) and optional click sound makes the video more professional and easier to follow. This is a new pipeline stage with its own config, consistent with existing stages like `autoZoom` and `textProcessing`.

## Scope

- Visual ripple effect on click actions only (not hover, fill, drag)
- Optional click sound (bundled default + custom override)
- New `.clickEffect(config)` pipeline stage
- CLI flags: `--click-effect`, `--click-effect-config`, `--click-sound`

## Types

### ClickEffectConfig

```typescript
// src/types/click-effect.ts

export interface ClickEffectConfig {
  /** Ripple color as hex '#RRGGBB'. Default: '#3B82F6' (blue) */
  color?: string
  /** Ripple opacity 0.0–1.0. Default: 0.5 */
  opacity?: number
  /** Max ripple radius in px, relative to 1080p. Default: 30 */
  radius?: number
  /** Ripple animation duration in ms. Default: 400 */
  duration?: number
  /** Path to click sound file, or `true` for bundled default. Default: undefined (no sound) */
  sound?: string | true
  /** Click sound volume 0.0–1.0. Default: 0.8 */
  soundVolume?: number
  /** Filter which click actions to highlight. Default: all clicks with coordinates */
  filter?: (action: TraceAction) => boolean
}
```

### ClickEvent (internal)

```typescript
// Used internally by executor → renderer

export interface ClickEvent {
  /** X coordinate in viewport pixels */
  x: number
  /** Y coordinate in viewport pixels */
  y: number
  /** Timestamp in video time (ms), after speed remapping */
  videoTimeMs: number
}
```

## Pipeline Integration

### Stage descriptor

Add to `StageDescriptor` union in `src/pipeline/stages.ts`:

```typescript
| { type: 'clickEffect'; config: ClickEffectConfig }
```

### Pipeline builder

Add to `src/pipeline/pipeline.ts`:

```typescript
clickEffect(config?: ClickEffectConfig): Pipeline
```

Position in chain: after `autoZoom`/`enrichZoomFromReport`, before `voiceover`.

### Executor logic (`src/pipeline/executor.ts`)

Prerequisite: `parse()` must have been called (needs `ParsedTrace.actions`).

1. Filter click actions: `actions.filter(a => a.method === 'click' && a.point)`
2. Apply user `filter()` if configured
3. Remap timestamps: if speed processing was applied, use `TimeRemapFn` to convert trace monotonic timestamps to video time
4. Convert cursor coordinates: if device pixel ratio > 1, scale accordingly
5. Store `ClickEvent[]` array on pipeline state for renderer

### State propagation

Add `clickEvents?: ClickEvent[]` to `PipelineState`. The renderer reads this array when present.

## Renderer — Visual Ripple

### Ripple clip generation

Generate a short transparent video clip (~400ms) containing a single ripple animation:

1. Use ffmpeg `lavfi` input: `color=c=black@0:s=SIZExSIZE:d=DURATION:r=FPS,format=rgba`
2. Apply `geq` filter to draw an expanding circle with fading alpha:
   - Circle radius grows linearly from 0 to `radius` over duration
   - Alpha starts at `opacity * 255` and fades to 0
   - Soft edge (2-3px anti-aliasing gradient)
3. Output to temp file (ProRes 4444 with alpha, or PNG codec in MOV)
4. `SIZE` = `radius * 2 + padding` (e.g., for radius 30: 64x64 px)
5. Scale to source resolution ratio (radius is relative to 1080p)

### Per-click overlay

Each click gets its own independent ripple stream using the `movie` filter + `setpts` to position it at the correct time:

```
movie=ripple.mov,setpts=PTS+T0/TB,format=rgba[r0];
movie=ripple.mov,setpts=PTS+T1/TB,format=rgba[r1];
[0:v][r0]overlay=x=X0-R:y=Y0-R:eof_action=pass[v1];
[v1][r1]overlay=x=X1-R:y=Y1-R:eof_action=pass[v2];
```

Where:
- `X, Y` = click coordinates (scaled to source resolution)
- `R` = half of ripple clip size (centering offset)
- `T` = click video time in seconds
- `setpts=PTS+T/TB` shifts the ripple to start at time T in the output timeline
- `eof_action=pass` lets the base video continue after the ripple ends

Each `movie` instance creates an independent stream, so the ripple animation always starts from frame 0 regardless of when the click occurs in the video.

### Integration with zoom

Click overlay is applied AFTER zoom processing. The renderer's phase order:
1. Speed processing (setpts)
2. Zoom processing (segment-based crop+scale)
3. **Click overlay** (per-click ripple on final video)
4. Video padding (tpad for voiceover overflow)
5. Final encode (scale, subtitles, audio)

## Renderer — Click Sound

### Default sound

A synthetic click generated with ffmpeg at render time (short sine burst ~30ms, 4kHz):
```
ffmpeg -f lavfi -i "sine=frequency=4000:duration=0.03" -af "afade=t=in:d=0.005,afade=t=out:d=0.02" click.mp3
```

Alternatively, a pre-recorded click can be bundled as base64 in `src/click-effect/default-click.ts` and decoded to temp file. User's custom sound path always takes priority.

### Sound track generation

1. For each `ClickEvent`, place the click sound at `videoTimeMs`
2. Build ffmpeg concat demuxer: alternating silence segments + click sound
3. Output as single audio track (MP3)

### Audio mixing

- If voiceover exists: `amix` click track with voiceover track, with click volume adjustment
- If no voiceover: click track becomes the audio track
- Volume controlled by `soundVolume` config

## CLI

### Flags

```
--click-effect                Enable click effect with default config
--click-effect-config <path>  Load ClickEffectConfig from JSON file
--click-sound <path>          Custom click sound file (shorthand for sound field)
```

### JSON config example

```json
{
  "color": "#FF6B35",
  "opacity": 0.6,
  "radius": 40,
  "duration": 500,
  "sound": true,
  "soundVolume": 0.7
}
```

### CLI behavior

- `--click-effect` alone: uses all defaults (visual only, no sound)
- `--click-effect --click-sound click.mp3`: visual + custom sound
- `--click-effect-config config.json`: full config from file
- `--click-effect-config config.json --click-sound override.mp3`: config file + sound override

## Public API Exports

Add to `src/index.ts`:

```typescript
export type { ClickEffectConfig, ClickEvent } from './types/click-effect.js'
```

## Files to Create

| File | Purpose |
|------|---------|
| `src/types/click-effect.ts` | `ClickEffectConfig` and `ClickEvent` interfaces |
| `src/click-effect/default-click.ts` | Base64-encoded default click sound |
| `src/click-effect/ripple-generator.ts` | ffmpeg lavfi ripple clip generation |
| `src/click-effect/sound-track.ts` | Click sound track assembly |

## Files to Modify

| File | Change |
|------|--------|
| `src/pipeline/stages.ts` | Add `clickEffect` stage descriptor |
| `src/pipeline/pipeline.ts` | Add `.clickEffect()` method |
| `src/pipeline/executor.ts` | Add `clickEffect` case — extract clicks, remap timestamps |
| `src/render/renderer.ts` | Add ripple overlay phase + click sound mixing |
| `src/cli.ts` | Add `--click-effect`, `--click-effect-config`, `--click-sound` flags |
| `src/index.ts` | Export new types |

## Verification

1. **Unit tests** — `tests/unit/click-effect/` for ripple generation, sound track assembly, executor logic
2. **Type check** — `npx tsc --noEmit`
3. **Integration test** — process a trace with click actions, verify output video has ripple overlays
4. **Manual test** — render demo video with `--click-effect`, check visual quality and timing
5. **Audio test** — render with `--click-effect --click-sound click.mp3`, verify clicks are audible at correct times
