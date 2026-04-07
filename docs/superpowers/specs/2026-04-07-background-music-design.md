# Background Music Support

**Date:** 2026-04-07
**Status:** Approved

## Context

playwright-recast produces polished demo videos from Playwright traces with voiceover, subtitles, click sounds, and visual effects. Currently the only audio sources are TTS voiceover and click effect sounds. Demo videos benefit from background music that plays underneath narration, adding polish and professional feel. This spec adds a `backgroundMusic()` pipeline stage.

## Requirements

- User provides a path to an audio file (mp3/wav/ogg/m4a)
- Music loops if shorter than the video, trims if longer
- Fade out at the end of the video (configurable duration)
- Auto-ducking: lower music volume during voiceover segments, restore between them
- Ducking can be disabled for fixed-volume mode
- Configurable: base volume, duck level, duck fade duration, fade-out duration

## API

### Pipeline method

```typescript
.backgroundMusic({
  path: './music.mp3',       // required: path to audio file
  volume: 0.3,               // base volume 0.0-1.0 (default: 0.3)
  ducking: true,              // auto-duck during voiceover (default: true)
  duckLevel: 0.1,             // volume during voiceover 0.0-1.0 (default: 0.1)
  duckFadeMs: 500,            // fade in/out duration for ducking transitions (default: 500)
  fadeOutMs: 3000,            // fade out at end of video (default: 3000)
  loop: true,                 // loop if shorter than video (default: true)
})
```

### Type definition — `src/types/background-music.ts`

```typescript
export interface BackgroundMusicConfig {
  /** Path to the audio file (mp3, wav, ogg, m4a) */
  path: string
  /** Base volume level 0.0-1.0 (default: 0.3) */
  volume?: number
  /** Auto-duck music during voiceover segments (default: true) */
  ducking?: boolean
  /** Volume level during voiceover 0.0-1.0 (default: 0.1) */
  duckLevel?: number
  /** Fade duration in ms for ducking transitions (default: 500) */
  duckFadeMs?: number
  /** Fade out duration in ms at end of video (default: 3000) */
  fadeOutMs?: number
  /** Loop audio if shorter than video (default: true) */
  loop?: boolean
}
```

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/types/background-music.ts` | `BackgroundMusicConfig` interface |
| `src/background-music/music-processor.ts` | Core logic: loop, duck, fade, output processed track |

### Modified files

| File | Change |
|------|--------|
| `src/pipeline/stages.ts` | Add `backgroundMusic` stage to `StageDescriptor` union |
| `src/pipeline/pipeline.ts` | Add `backgroundMusic()` fluent method |
| `src/pipeline/executor.ts` | Handle stage, store config in `PipelineState` |
| `src/render/renderer.ts` | Generate music track, mix into final audio |
| `src/index.ts` | Export `BackgroundMusicConfig` type |

### Music processor — `src/background-music/music-processor.ts`

```typescript
export interface MusicTrackInput {
  config: BackgroundMusicConfig
  videoDurationMs: number
  voiceoverSegments: Array<{ startMs: number; endMs: number }>
  tmpDir: string
}

export function generateMusicTrack(input: MusicTrackInput): string
```

**Processing pipeline (single function, sequential ffmpeg calls):**

1. **Loop/trim** — If music shorter than video and `loop: true`, use ffmpeg `-stream_loop -1` with `-t` to loop to video length. If longer, trim with `-t`.

2. **Duck** — If `ducking: true` and voiceover segments exist, apply ffmpeg `volume` filter with `enable` expressions. For each voiceover segment, build an expression that fades volume from `volume` to `duckLevel` over `duckFadeMs` before the segment starts, holds at `duckLevel` during the segment, and fades back to `volume` over `duckFadeMs` after it ends. Uses `between(t,start,end)` expressions.

3. **Fade out** — Apply `afade=t=out:st=<start>:d=<fadeOutMs/1000>` for the final seconds.

4. **Return** path to the processed track.

### Ducking expression strategy

For each voiceover segment `[startMs, endMs]`, the volume at time `t` follows:

- Before duck: `volume` (base level)
- Fade down: `t` in `[startMs - duckFadeMs, startMs]` → linear interpolation from `volume` to `duckLevel`
- During voiceover: `duckLevel`
- Fade up: `t` in `[endMs, endMs + duckFadeMs]` → linear interpolation from `duckLevel` to `volume`
- After duck: `volume`

Adjacent voiceover segments closer than `2 * duckFadeMs` should be merged to avoid rapid volume oscillation.

Implementation: Build a single ffmpeg `volume` filter expression using nested `if(between(...), ...)` clauses covering all merged segments. This handles arbitrary numbers of voiceover segments in one pass.

### Renderer integration

**Phase 3.8** (new, after click sound generation in Phase 3.7):

```
if backgroundMusicConfig exists:
  videoDurationMs = getVideoDuration(videoInput) * 1000
  voiceoverSegments = extract from state.voiceovered?.voiceover.entries
  musicTrackPath = generateMusicTrack({ config, videoDurationMs, voiceoverSegments, tmpDir })
```

**Phase 5** (final encode, extend existing audio mixing):

Current flow: voiceover → mix click sounds → `finalAudioPath`

New flow: voiceover → mix click sounds → mix background music → `finalAudioPath`

The background music is always the last audio source mixed in, at the lowest priority. Uses the same `amix` pattern already established for click sounds.

### Pipeline state

Add to `PipelineState` in `executor.ts`:

```typescript
backgroundMusicConfig?: BackgroundMusicConfig
```

### Renderable trace

Add to `RenderableTrace` in `renderer.ts`:

```typescript
backgroundMusicConfig?: BackgroundMusicConfig
```

## Stage ordering

`backgroundMusic()` can be called at any point in the pipeline (the config is just stored). The actual audio processing happens during rendering, after voiceover generation (so ducking segments are known).

Recommended position in pipeline:

```typescript
Recast.from('./traces/')
  .parse()
  .hideSteps(...)
  .speedUp(...)
  .subtitlesFromSrt(...)
  .textProcessing(...)
  .autoZoom(...)
  .cursorOverlay()
  .clickEffect({ sound: true })
  .backgroundMusic({ path: './music.mp3' })  // here
  .voiceover(ElevenLabsProvider(...))
  .render(...)
  .toFile('demo.mp4')
```

## Edge cases

- **No voiceover, ducking enabled** — ducking is a no-op (no segments to duck for). Music plays at base volume.
- **Music file doesn't exist** — throw error at stage registration (in executor, like intro/outro).
- **Very short video (<1s)** — fade out is clamped to not exceed video duration.
- **Adjacent voiceover segments** — merge segments closer than `2 * duckFadeMs` to prevent volume oscillation.

## Verification

1. **Unit tests** for `generateMusicTrack`:
   - Loop behavior: short music + long video → output duration matches video
   - Trim behavior: long music + short video → output duration matches video
   - Ducking expression builder: verify correct volume expressions for given segments
   - Segment merging: adjacent segments get merged

2. **Integration test**: Build a pipeline with `backgroundMusic()` + `voiceover()`, verify output video has audio track with expected duration.

3. **Manual test**: Run with a real trace, listen to the output to verify ducking sounds natural.
