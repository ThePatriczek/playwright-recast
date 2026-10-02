import { describe, it, expect } from 'vitest'
import { cueForZoomMarker, moveZoomsToSpokenNarration } from '../../../src/pipeline/zoom-markers'
import type { SubtitleEntry } from '../../../src/types/subtitle'

// Two narrations, each ended by waitForNarration(), with a gap between them.
const cues = [
  { startMs: 1000, endMs: 4000 },
  { startMs: 5000, endMs: 8000 },
]

describe('cueForZoomMarker()', () => {
  it('picks the cue playing at the marker', () => {
    expect(cueForZoomMarker(cues, 2000)).toBe(cues[0])
  })

  it('picks the next cue for a marker set just before narrate()', () => {
    expect(cueForZoomMarker(cues, 4500)).toBe(cues[1])
    expect(cueForZoomMarker(cues, 500)).toBe(cues[0])
  })

  it('picks the next cue at a cue boundary', () => {
    expect(cueForZoomMarker(cues, 4000)).toBe(cues[1])
  })

  it('finds nothing after the last cue', () => {
    expect(cueForZoomMarker(cues, 9000)).toBeUndefined()
  })
})

describe('moveZoomsToSpokenNarration()', () => {
  // Narration 1 is spoken over a wait: its audio ends at 3000 but its
  // subtitle stays open until narration 2 starts at 10000.
  const setup = (zoomAt: number, ownZoomOn2 = false, zoomEnd?: number) => {
    const zoom = { x: 0.4, y: 0.6, level: 1.3, ...(zoomEnd !== undefined ? { endMs: zoomEnd } : {}) }
    const s1: SubtitleEntry = { index: 1, startMs: 1000, endMs: 10_000, text: 'planning', zoom: { ...zoom, startMs: zoomAt } }
    const s2: SubtitleEntry = { index: 2, startMs: 10_000, endMs: 14_000, text: 'answer', ...(ownZoomOn2 ? { zoom: { x: 0.1, y: 0.1, level: 2, startMs: 11_000 } } : {}) }
    // Silence pads narration 1's cue to 10000; the speech ends at 3000.
    const entries = [
      { subtitle: s1, outputStartMs: 1000, outputEndMs: 10_000, spokenEndMs: 3000 },
      { subtitle: s2, outputStartMs: 10_000, outputEndMs: 14_000, spokenEndMs: 14_000 },
    ]
    moveZoomsToSpokenNarration(entries)
    return { s1, s2 }
  }

  it('moves a zoom set after its narration was spoken to the next one', () => {
    const { s1, s2 } = setup(9_500)
    expect(s1.zoom).toBeUndefined()
    expect(s2.zoom).toEqual({ x: 0.4, y: 0.6, level: 1.3, startMs: 10_000 })
  })

  it('keeps a zoom set while its narration is spoken', () => {
    const { s1, s2 } = setup(2_000)
    expect(s1.zoom?.startMs).toBe(2_000)
    expect(s2.zoom).toBeUndefined()
  })

  it('keeps an autoZoom() window, which follows the actions', () => {
    const { s1, s2 } = setup(9_500, false, 10_000)
    expect(s1.zoom).toEqual({ x: 0.4, y: 0.6, level: 1.3, startMs: 9_500, endMs: 10_000 })
    expect(s2.zoom).toBeUndefined()
  })

  it('moves chained stale zooms each to the next narration', () => {
    // Both narrations are spoken over a wait; each zoom comes after its audio.
    const zoom = (x: number, startMs: number) => ({ x, y: 0.5, level: 1.5, startMs })
    const s1: SubtitleEntry = { index: 1, startMs: 1000, endMs: 10_000, text: 'one', zoom: zoom(0.1, 9_000) }
    const s2: SubtitleEntry = { index: 2, startMs: 10_000, endMs: 20_000, text: 'two', zoom: zoom(0.2, 19_000) }
    const s3: SubtitleEntry = { index: 3, startMs: 20_000, endMs: 24_000, text: 'three' }
    moveZoomsToSpokenNarration([
      { subtitle: s1, outputStartMs: 1000, outputEndMs: 10_000, spokenEndMs: 3000 },
      { subtitle: s2, outputStartMs: 10_000, outputEndMs: 20_000, spokenEndMs: 12_000 },
      { subtitle: s3, outputStartMs: 20_000, outputEndMs: 24_000, spokenEndMs: 24_000 },
    ])
    expect([s1.zoom?.x, s2.zoom?.x, s3.zoom?.x]).toEqual([undefined, 0.1, 0.2])
  })

  it('leaves a narration its own zoom and drops the stale one', () => {
    const { s1, s2 } = setup(9_500, true)
    expect(s1.zoom).toBeUndefined()
    expect(s2.zoom?.level).toBe(2)
  })
})

describe('zooms stay in their scene', () => {
  const cues = [
    { startMs: 1000, endMs: 4000, sceneId: 'step-5' },
    { startMs: 5000, endMs: 8000, sceneId: 'step-6' },
  ]

  it('cueForZoomMarker() does not pick the next cue from another scene', () => {
    expect(cueForZoomMarker(cues, 4500, 'step-5')).toBeUndefined()
    expect(cueForZoomMarker(cues, 4500, 'step-6')).toBe(cues[1])
    expect(cueForZoomMarker(cues, 2000, 'step-5')).toBe(cues[0])
    expect(cueForZoomMarker(cues, 4500)).toBe(cues[1])
  })

  it('cueForZoomMarker() skips a playing cue from another step for the next one in its own', () => {
    // Step 5 narrates without waitForNarration(), so its cue is still open
    // when step 6 sets a zoom before its own narrate().
    const open = [
      { startMs: 1000, endMs: 5000, sceneId: 'step-5' },
      { startMs: 5000, endMs: 8000, sceneId: 'step-6' },
    ]
    expect(cueForZoomMarker(open, 4500, 'step-6')).toBe(open[1])
  })

  it('cueForZoomMarker() gives a zoom outside any scene the next cue', () => {
    expect(cueForZoomMarker(cues, 4500, undefined)).toBe(cues[1])
  })

  it('moveZoomsToSpokenNarration() keeps a stale zoom when the next narration is another scene', () => {
    // Step 5 zooms a dialog after its line was spoken; step 6 opens with a narration hold.
    const s5: SubtitleEntry = { index: 1, startMs: 1000, endMs: 10_000, text: 'publish', sceneId: 'step-5', zoom: { x: 0.8, y: 0.5, level: 1.3, startMs: 9_000, sceneId: 'step-5' } }
    const s6: SubtitleEntry = { index: 2, startMs: 10_000, endMs: 14_000, text: 'connect', sceneId: 'step-6' }
    moveZoomsToSpokenNarration([
      { subtitle: s5, outputStartMs: 1000, outputEndMs: 10_000, spokenEndMs: 3000 },
      { subtitle: s6, outputStartMs: 10_000, outputEndMs: 14_000, spokenEndMs: 14_000 },
    ])
    expect(s5.zoom?.startMs).toBe(9_000)
    expect(s6.zoom).toBeUndefined()
  })

  it('moveZoomsToSpokenNarration() moves a zoom from outside any scene, even off a scene\'s cue', () => {
    // Narrations in say() wrapper steps; the zoom ran in the test body after
    // line A was spoken and sits on A's cue, which stays open to B.
    const a: SubtitleEntry = { index: 1, startMs: 1000, endMs: 10_000, text: 'A', sceneId: 'say@1', zoom: { x: 0.5, y: 0.5, level: 1.5, startMs: 9_000 } }
    const b: SubtitleEntry = { index: 2, startMs: 10_000, endMs: 14_000, text: 'B', sceneId: 'say@5' }
    moveZoomsToSpokenNarration([
      { subtitle: a, outputStartMs: 1000, outputEndMs: 10_000, spokenEndMs: 3000 },
      { subtitle: b, outputStartMs: 10_000, outputEndMs: 14_000, spokenEndMs: 14_000 },
    ])
    expect(a.zoom).toBeUndefined()
    expect(b.zoom?.startMs).toBe(10_000)
  })
})
