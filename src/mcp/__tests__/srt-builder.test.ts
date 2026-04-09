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
    expect(srt).toContain('2\n00:00:12,000 --> 00:00:17,000\nAsk your question.')
    expect(srt).not.toContain('step-1')
  })

  it('extends last entry by 5s', () => {
    const steps = [
      { id: 'step-1', hidden: false, startTimeMs: 0, endTimeMs: 3000, voiceover: 'Only step.' },
    ]
    const srt = buildSrtFromSteps(steps)
    expect(srt).toContain('00:00:00,000 --> 00:00:05,000')
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

  it('returns empty string for no voiceover steps', () => {
    const steps = [
      { id: 'step-1', hidden: true, startTimeMs: 0, endTimeMs: 5000, voiceover: 'Hidden.' },
    ]
    expect(buildSrtFromSteps(steps)).toBe('')
  })
})
