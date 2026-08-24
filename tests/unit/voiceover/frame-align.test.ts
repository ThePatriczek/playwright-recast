import { describe, it, expect } from 'vitest'
import { msPerFrame, alignMsUpToFrame, alignFreezeToFrame } from '../../../src/voiceover/frame-align'

describe('msPerFrame', () => {
  it('converts a frame rate to milliseconds per frame', () => {
    expect(msPerFrame(25)).toBe(40)
    expect(msPerFrame(50)).toBe(20)
  })
})

describe('alignMsUpToFrame', () => {
  it('leaves a value already on a frame boundary unchanged', () => {
    expect(alignMsUpToFrame(0, 25)).toBe(0)
    expect(alignMsUpToFrame(40, 25)).toBe(40)
    expect(alignMsUpToFrame(120, 25)).toBe(120)
  })

  it('pushes a value forward to the next frame boundary', () => {
    expect(alignMsUpToFrame(1, 25)).toBe(40)
    expect(alignMsUpToFrame(100, 25)).toBe(120)
    expect(alignMsUpToFrame(7025, 25)).toBe(7040)
  })

  it('never moves a value backwards', () => {
    for (const ms of [0, 1, 39, 40, 41, 999, 1000]) {
      expect(alignMsUpToFrame(ms, 25)).toBeGreaterThanOrEqual(ms)
    }
  })

  it('returns the input unchanged for a non-positive frame rate', () => {
    expect(alignMsUpToFrame(123, 0)).toBe(123)
    expect(alignMsUpToFrame(123, -5)).toBe(123)
  })

  it('returns the input unchanged for a NaN or missing frame rate', () => {
    expect(alignMsUpToFrame(123, NaN)).toBe(123)
    expect(alignMsUpToFrame(123, undefined as unknown as number)).toBe(123)
  })
})

describe('alignFreezeToFrame', () => {
  it('moves the fractional remainder from the position into the duration, then quantises it', () => {
    // 100ms is 2.5 frames at 25fps; the hold starts 20ms later, so the raw
    // hold shrinks by 20ms to 480ms — which is already a whole number of
    // frames (12), so quantising it changes nothing here.
    const r = alignFreezeToFrame(100, 500, 25)
    expect(r.atVideoMs).toBe(120)
    expect(r.durationMs).toBe(480)
  })

  it('quantises both endpoints onto frame boundaries for every input', () => {
    // The end position is no longer preserved exactly (see the doc comment):
    // both the start and the duration are independently snapped to whole
    // frames, so the end can drift by up to half a frame from the raw input.
    for (const at of [0, 7, 33, 100, 7025]) {
      const r = alignFreezeToFrame(at, 1000, 25)
      expect(r.atVideoMs % 40).toBe(0)
      expect(r.durationMs % 40).toBe(0)
      const end = r.atVideoMs + r.durationMs
      expect(end % 40).toBe(0)
      // Never drifts by more than half a frame from the original end.
      expect(Math.abs(end - (at + 1000))).toBeLessThanOrEqual(20)
    }
  })

  it('leaves an already-aligned freeze untouched', () => {
    const r = alignFreezeToFrame(120, 480, 25)
    expect(r).toEqual({ atVideoMs: 120, durationMs: 480 })
  })

  it('clamps the duration at zero rather than going negative', () => {
    // A 5ms hold at a position needing a 20ms push cannot absorb the shift.
    const r = alignFreezeToFrame(100, 5, 25)
    expect(r.atVideoMs).toBe(120)
    expect(r.durationMs).toBe(0)
  })

  it('returns inputs unchanged for a non-positive frame rate', () => {
    expect(alignFreezeToFrame(100, 500, 0)).toEqual({ atVideoMs: 100, durationMs: 500 })
  })

  it('returns inputs unchanged for a NaN or missing frame rate', () => {
    expect(alignFreezeToFrame(100, 500, NaN)).toEqual({ atVideoMs: 100, durationMs: 500 })
    expect(alignFreezeToFrame(100, 500, undefined as unknown as number)).toEqual({
      atVideoMs: 100,
      durationMs: 500,
    })
  })
})
