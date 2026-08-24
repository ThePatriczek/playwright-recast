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
  it('snaps both the start and the end of a freeze to a frame boundary', () => {
    // Regression: overflow freezes were recorded at raw ms, so the boundary
    // frame landed in whichever cue ffmpeg happened to round toward.
    // alignFreezeToFrame quantises the duration too (see its doc comment), so
    // the end position is no longer exact — it can drift by up to half a
    // frame from the raw input, but always lands on a frame boundary itself.
    const raw = { atVideoMs: 7025, durationMs: 1200 }
    const aligned = alignFreezeToFrame(raw.atVideoMs, raw.durationMs, 25)

    expect(aligned.atVideoMs % 40).toBe(0)
    expect(aligned.atVideoMs).toBeGreaterThanOrEqual(raw.atVideoMs)
    expect(aligned.durationMs % 40).toBe(0)
    const end = aligned.atVideoMs + aligned.durationMs
    expect(end % 40).toBe(0)
    expect(Math.abs(end - (raw.atVideoMs + raw.durationMs))).toBeLessThanOrEqual(20)
  })

  it('accumulates no unbounded drift across a run of freezes', () => {
    // Ten freezes, none frame-aligned. Each one independently quantises to a
    // whole number of frames, so per-freeze drift is bounded to half a frame
    // and does not compound across the run — that bound is what this
    // module exists to guarantee, not exact end-position preservation.
    const raws = Array.from({ length: 10 }, (_, i) => ({
      atVideoMs: 1000 + i * 333,
      durationMs: 250,
    }))
    const aligned = raws.map((f) => alignFreezeToFrame(f.atVideoMs, f.durationMs, 25))

    aligned.forEach((f, i) => {
      expect(f.atVideoMs % 40).toBe(0)
      expect(f.durationMs % 40).toBe(0)
      const end = f.atVideoMs + f.durationMs
      const rawEnd = raws[i]!.atVideoMs + raws[i]!.durationMs
      expect(Math.abs(end - rawEnd)).toBeLessThanOrEqual(20)
    })
  })
})
