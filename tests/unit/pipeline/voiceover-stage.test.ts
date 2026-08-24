import { describe, it, expect } from 'vitest'
import { Recast } from '../../../src/index'
import type { TtsProvider } from '../../../src/types/voiceover'
import { alignFreezeToFrame } from '../../../src/voiceover/frame-align'

const fakeProvider: TtsProvider = {
  name: 'fake',
  async synthesize() { return [] },
  async isAvailable() { return true },
  async dispose() {},
}

describe('Pipeline.voiceover(provider, options)', () => {
  it('stores the provider without options when none are given', () => {
    const p = Recast.from('./t').parse().voiceover(fakeProvider)
    const stage = p.getStages().find((s) => s.type === 'voiceover')
    expect(stage?.type).toBe('voiceover')
    if (stage?.type === 'voiceover') {
      expect(stage.provider).toBe(fakeProvider)
      expect(stage.options).toBeUndefined()
    }
  })

  it('stores VoiceoverOptions including normalize: true', () => {
    const p = Recast.from('./t').parse().voiceover(fakeProvider, { normalize: true })
    const stage = p.getStages().find((s) => s.type === 'voiceover')
    if (stage?.type !== 'voiceover') throw new Error('missing stage')
    expect(stage.options).toEqual({ normalize: true })
  })

  it('stores VoiceoverOptions with a custom LoudnessNormalizeConfig', () => {
    const p = Recast.from('./t').parse().voiceover(fakeProvider, {
      normalize: { targetLufs: -18, truePeakDb: -1.5, linear: false },
    })
    const stage = p.getStages().find((s) => s.type === 'voiceover')
    if (stage?.type !== 'voiceover') throw new Error('missing stage')
    expect(stage.options).toEqual({
      normalize: { targetLufs: -18, truePeakDb: -1.5, linear: false },
    })
  })
})

describe('freeze frame alignment (#22 item 5)', () => {
  it('keeps a freeze end position while snapping its start to a frame', () => {
    // Regression: overflow freezes were recorded at raw ms, so the boundary
    // frame landed in whichever cue ffmpeg happened to round toward.
    const raw = { atVideoMs: 7025, durationMs: 1200 }
    const aligned = alignFreezeToFrame(raw.atVideoMs, raw.durationMs, 25)

    expect(aligned.atVideoMs % 40).toBe(0)
    expect(aligned.atVideoMs).toBeGreaterThanOrEqual(raw.atVideoMs)
    expect(aligned.atVideoMs + aligned.durationMs).toBe(raw.atVideoMs + raw.durationMs)
  })

  it('accumulates no drift across a run of freezes', () => {
    // Ten freezes, none frame-aligned. The sum of durations plus the first
    // start must equal what it was before alignment, or every later cue moves.
    const raws = Array.from({ length: 10 }, (_, i) => ({
      atVideoMs: 1000 + i * 333,
      durationMs: 250,
    }))
    const rawTotal = raws.reduce((a, f) => a + f.durationMs, 0)
    const aligned = raws.map((f) => alignFreezeToFrame(f.atVideoMs, f.durationMs, 25))
    const alignedTotal = aligned.reduce((a, f) => a + f.durationMs, 0)

    // Each hold gives up at most one frame's worth to its own position shift.
    expect(rawTotal - alignedTotal).toBeLessThanOrEqual(10 * 40)
    // And every freeze's end position is exactly preserved.
    aligned.forEach((f, i) => {
      expect(f.atVideoMs + f.durationMs).toBe(raws[i]!.atVideoMs + raws[i]!.durationMs)
    })
  })
})
