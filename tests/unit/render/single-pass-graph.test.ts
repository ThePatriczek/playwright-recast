import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderVideo, probeResolution, type RenderableTrace } from '../../../src/render/renderer'
import { resolveCursorOverlayConfig } from '../../../src/cursor-overlay/defaults'
import { toMonotonic } from '../../../src/types/trace'
import type { SubtitleEntry } from '../../../src/types/subtitle'

/**
 * Highlights, cursor, click ripples and zoom used to be one full re-encode
 * each, feeding the final encode a fifth time. On a real 764s 1440p screencast
 * that was 403s of the 582s total. They are all frame-in/frame-out filters, so
 * renderVideo() now stacks them into a single ffmpeg graph.
 *
 * These tests pin the invariants the collapse depends on: no stage writes an
 * intermediate video any more, the tail filters (scale, subtitle burn) still
 * close the graph, and every overlay still lands on the pixels it used to.
 *
 * Sources here must be visually busy: detectBlankLeadIn() reads a flat fill as
 * blank and trims it, which silently shortens the clip under test.
 */

const VIEWPORT = { width: 640, height: 360 }
const SOURCE_RES = { width: 640, height: 360 }
const TARGET = { width: 320, height: 180 }
const DURATION_SEC = 4
const FPS = 25

let TMP_ROOT: string
/** Busy pattern, so nothing is mistaken for a blank lead-in. */
let SRC: string
/** Flat background with a centred 80x80 red square, for the zoom geometry. */
let SQUARE_SRC: string

/** The per-stage outputs the collapsed pass must no longer produce. */
const INTERMEDIATE_VIDEOS = [
  'highlight-overlay.mp4',
  'cursor-overlay.mp4',
  'click-overlay.mp4',
  'zoom-combined.mp4',
]

function encode(lavfi: string, dest: string): void {
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', lavfi,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', dest,
  ], { stdio: 'pipe' })
}

function countFrames(file: string): number {
  return Number(execFileSync('ffprobe', [
    '-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file,
  ]).toString().trim())
}

/**
 * RGB of one pixel of the frame shown at `atSec`.
 *
 * Converts to rgb24 before cropping: on a yuv420p frame, crop rounds a 1px
 * width down to the chroma subsampling and fails with "non positive size".
 */
function pixelAt(video: string, atSec: number, x: number, y: number): [number, number, number] {
  const raw = path.join(TMP_ROOT, 'pixel.raw')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-ss', String(atSec), '-i', video, '-frames:v', '1',
    '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw,
  ], { stdio: 'pipe' })
  const buf = fs.readFileSync(raw)
  if (buf.length < 3) throw new Error(`no frame at ${atSec}s in ${video}`)
  return [buf[0]!, buf[1]!, buf[2]!]
}

const isRed = ([r, g, b]: [number, number, number]): boolean => r > 120 && g < 90 && b < 90
const isYellow = ([r, g, b]: [number, number, number]): boolean => r > 150 && g > 150 && b < 110

/** A trace carrying only what renderVideo reads: no speed map, no audio. */
function baseTrace(overrides: Partial<RenderableTrace> = {}): RenderableTrace {
  return {
    metadata: {
      browserName: 'chromium',
      platform: 'linux',
      viewport: VIEWPORT,
      startTime: toMonotonic(0),
      endTime: toMonotonic(DURATION_SEC * 1000),
      wallTime: 0,
    },
    frames: [],
    actions: [],
    resources: [],
    events: [],
    cursorPositions: [],
    frameReader: { read: () => undefined } as unknown as RenderableTrace['frameReader'],
    sourceVideoPath: SRC,
    ...overrides,
  }
}

/** Renders into a fresh tmpDir so each case can inspect its own artefacts. */
function render(
  label: string,
  trace: RenderableTrace,
  config: Parameters<typeof renderVideo>[1] = {},
): { output: string; tmpDir: string } {
  const tmpDir = path.join(TMP_ROOT, label)
  fs.mkdirSync(tmpDir, { recursive: true })
  const output = path.join(TMP_ROOT, `${label}.mp4`)
  renderVideo(trace, { resolution: TARGET, ...config }, output, tmpDir)
  return { output, tmpDir }
}

/** A marker pinned to the frame's top-left corner, for the zoom crop check. */
const cornerMarker = () => ({
  x: 0, y: 0, width: 40, height: 40,
  videoTimeMs: 0, endTimeMs: DURATION_SEC * 1000,
  color: '#FF0000', opacity: 1.0, swipeDuration: 10, fadeOut: 10,
})

describe('overlay and zoom stages render in a single pass', () => {
  beforeAll(() => {
    TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-single-pass-test-'))
    SRC = path.join(TMP_ROOT, 'src.mp4')
    SQUARE_SRC = path.join(TMP_ROOT, 'square.mp4')
    encode(`testsrc=s=${SOURCE_RES.width}x${SOURCE_RES.height}:d=${DURATION_SEC}:r=${FPS}`, SRC)
    // Busy border keeps the blank detector quiet; the red square is what the
    // zoom geometry is measured against.
    encode(
      `testsrc=s=${SOURCE_RES.width}x${SOURCE_RES.height}:d=${DURATION_SEC}:r=${FPS},`
      + `drawbox=x=280:y=140:w=80:h=80:color=red@1.0:t=fill`,
      SQUARE_SRC,
    )
  })

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  const everyStage = (): RenderableTrace => baseTrace({
    subtitles: [{
      index: 0,
      startMs: 0,
      endMs: DURATION_SEC * 1000,
      text: 'zoomed cue',
      zoom: { x: 0.5, y: 0.5, level: 2.0 },
    }] satisfies SubtitleEntry[],
    highlightEvents: [{
      x: 20, y: 20, width: 100, height: 30,
      videoTimeMs: 500, endTimeMs: 1500,
      color: '#FFFF00', opacity: 0.6, swipeDuration: 200, fadeOut: 200,
    }],
    cursorKeyframes: [
      { x: 100, y: 100, videoTimeSec: 1.0 },
      { x: 300, y: 200, videoTimeSec: 2.5 },
    ],
    cursorOverlayConfig: resolveCursorOverlayConfig({}),
    clickEvents: [{ x: 300, y: 200, videoTimeMs: 2500 }],
    clickEffectConfig: {
      color: '#3B82F6', opacity: 0.9, radius: 40, duration: 600, soundVolume: 0,
    },
  })

  it('writes no per-stage intermediate video', () => {
    const { tmpDir } = render('collapsed', everyStage())
    const leftovers = INTERMEDIATE_VIDEOS.filter((f) => fs.existsSync(path.join(tmpDir, f)))
    expect(leftovers).toEqual([])
  })

  it('preserves the source frame count and emits the target resolution', () => {
    const { output } = render('resolution', everyStage())
    expect(probeResolution(output)).toEqual(TARGET)
    expect(countFrames(output)).toBe(DURATION_SEC * FPS)
  })

  it('scales to the target with no zoom stage in the graph', () => {
    // zoompan is what resizes when a cue zooms; without it the graph tail owes
    // the output an explicit scale.
    const { output } = render('no-zoom', baseTrace({
      subtitles: [{ index: 0, startMs: 0, endMs: DURATION_SEC * 1000, text: 'no zoom here' }],
    }))
    expect(probeResolution(output)).toEqual(TARGET)
    expect(countFrames(output)).toBe(DURATION_SEC * FPS)
  })

  it('does not clone a live overlay into the audio padding', () => {
    // The audio outlasts the video, so the last frame is held. A highlight that
    // is still on screen there must not be held with it for the whole pad.
    const silence = path.join(TMP_ROOT, 'long-audio.mp3')
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', String(DURATION_SEC + 3), '-q:a', '9', silence,
    ], { stdio: 'pipe' })

    const withPad = render('pad-overlay', baseTrace({
      highlightEvents: [{
        x: 100, y: 100, width: 200, height: 60,
        videoTimeMs: 500, endTimeMs: DURATION_SEC * 1000,
        color: '#FFFF00', opacity: 1.0, swipeDuration: 100, fadeOut: 100,
      }],
      voiceover: {
        audioTrackPath: silence,
        entries: [],
        totalDurationMs: (DURATION_SEC + 3) * 1000,
      },
    })).output
    const x = Math.round(200 * TARGET.width / VIEWPORT.width)
    const y = Math.round(130 * TARGET.height / VIEWPORT.height)

    // Inside its window the mark is drawn; in the padded tail it is gone.
    expect(pixelAt(withPad, DURATION_SEC - 0.5, x, y))
      .not.toEqual(pixelAt(withPad, DURATION_SEC + 1.5, x, y))
    expect(isYellow(pixelAt(withPad, DURATION_SEC - 0.5, x, y))).toBe(true)
    expect(isYellow(pixelAt(withPad, DURATION_SEC + 1.5, x, y))).toBe(false)
  })

  it('burns subtitles through the graph tail', () => {
    const cue: SubtitleEntry[] = [
      { index: 0, startMs: 0, endMs: DURATION_SEC * 1000, text: 'BURNED IN' },
    ]
    const plain = render('no-burn', baseTrace({ subtitles: cue })).output
    const burned = render('burn', baseTrace({ subtitles: cue }), { burnSubtitles: true }).output

    // Somewhere along the caption band the burned render must differ.
    const band = Array.from({ length: 40 }, (_, i) => TARGET.width / 2 - 20 + i)
    const changed = band.some((x) => {
      const a = pixelAt(plain, 2, x, TARGET.height - 12)
      const b = pixelAt(burned, 2, x, TARGET.height - 12)
      return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]
    })
    expect(changed).toBe(true)
  })

  describe('each overlay still reaches the pixels', () => {
    /** Samples a viewport coordinate in the scaled-down output. */
    const at = (video: string, sec: number, vx: number, vy: number) =>
      pixelAt(video, sec,
        Math.round(vx * TARGET.width / VIEWPORT.width),
        Math.round(vy * TARGET.height / VIEWPORT.height))

    // Compared against the same render with that one stage removed, so a stage
    // that silently dropped out of the graph fails here.
    let bare: string
    beforeAll(() => { bare = render('bare', baseTrace()).output })

    it('draws the click ripple at the click position and time', () => {
      const withClick = render('click-only', baseTrace({
        clickEvents: [{ x: 320, y: 180, videoTimeMs: 2000 }],
        clickEffectConfig: {
          color: '#3B82F6', opacity: 1.0, radius: 60, duration: 800, soundVolume: 0,
        },
      })).output
      expect(at(withClick, 2.1, 320, 180)).not.toEqual(at(bare, 2.1, 320, 180))
      // ...and is gone once the ripple has expired.
      expect(at(withClick, 3.5, 320, 180)).toEqual(at(bare, 3.5, 320, 180))
    })

    it('draws the highlight marker inside its window and not after it', () => {
      const withHl = render('highlight-only', baseTrace({
        highlightEvents: [{
          x: 100, y: 100, width: 200, height: 60,
          videoTimeMs: 500, endTimeMs: 1500,
          color: '#FFFF00', opacity: 1.0, swipeDuration: 100, fadeOut: 100,
        }],
      })).output
      expect(at(withHl, 1.0, 200, 130)).not.toEqual(at(bare, 1.0, 200, 130))
      expect(at(withHl, 3.5, 200, 130)).toEqual(at(bare, 3.5, 200, 130))
    })

    it('draws the cursor at its keyframe position', () => {
      const withCursor = render('cursor-only', baseTrace({
        cursorKeyframes: [{ x: 320, y: 180, videoTimeSec: 2.0 }],
        cursorOverlayConfig: resolveCursorOverlayConfig({}),
      })).output
      // The cursor image is anchored at its top-left, so sample just inside it.
      expect(at(withCursor, 2.05, 324, 186)).not.toEqual(at(bare, 2.05, 324, 186))
    })

    it('zoom crops to the centre, doubling the on-screen size of a centred box', () => {
      // The source's red box spans x 280..360 of 640, so at 1:1 it covers
      // output x 140..180 — half-width 20 around centre 160. A 2x centre zoom
      // crops to the middle 320x180 and rescales, doubling that to 120..200.
      // x = 190 therefore sits outside the box unzoomed and inside it zoomed.
      const square = (label: string, zoom: boolean) => render(label, baseTrace({
        sourceVideoPath: SQUARE_SRC,
        subtitles: zoom
          ? [{
            index: 0, startMs: 0, endMs: DURATION_SEC * 1000, text: 'z',
            zoom: { x: 0.5, y: 0.5, level: 2.0 },
          }]
          : undefined,
      })).output

      const unzoomed = square('square-1x', false)
      const zoomed = square('square-2x', true)

      expect(isRed(pixelAt(unzoomed, 2, 160, 90))).toBe(true)
      expect(isRed(pixelAt(zoomed, 2, 160, 90))).toBe(true)
      expect(isRed(pixelAt(unzoomed, 2, 190, 90))).toBe(false)
      expect(isRed(pixelAt(zoomed, 2, 190, 90))).toBe(true)
    })

    it('keeps the corner marker unzoomed and crops it away at 2x', () => {
      const zoomed = render('corner-2x', baseTrace({
        subtitles: [{
          index: 0, startMs: 0, endMs: DURATION_SEC * 1000, text: 'z',
          zoom: { x: 0.5, y: 0.5, level: 2.0 },
        }],
        highlightEvents: [cornerMarker()],
      })).output
      const unzoomed = render('corner-1x', baseTrace({
        highlightEvents: [cornerMarker()],
      })).output

      expect(isRed(pixelAt(unzoomed, 2, 4, 4))).toBe(true)
      expect(isRed(pixelAt(zoomed, 2, 4, 4))).toBe(false)
    })
  })
}, 240_000)
