import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../../../src/parse/jsonl-parser'

describe('JSONL Parser', () => {
  it('parses valid JSONL lines', () => {
    const content = [
      '{"type":"context-options","browserName":"chromium"}',
      '{"type":"before","callId":"c1","title":"page.goto","class":"Page","method":"goto","startTime":100}',
    ].join('\n')

    const events = parseJsonl(content)
    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('context-options')
    expect(events[1]!.type).toBe('before')
  })

  it('skips empty lines', () => {
    const content = '{"type":"before","callId":"c1","title":"t","class":"C","method":"m","startTime":0}\n\n\n'
    expect(parseJsonl(content)).toHaveLength(1)
  })

  it('skips malformed JSON lines', () => {
    const content = [
      '{"type":"before","callId":"c1","title":"t","class":"C","method":"m","startTime":0}',
      'not-json',
      '{"type":"after","callId":"c1","endTime":100}',
    ].join('\n')

    const events = parseJsonl(content)
    expect(events).toHaveLength(2)
  })

  it('returns empty array for empty input', () => {
    expect(parseJsonl('')).toEqual([])
    expect(parseJsonl('\n\n')).toEqual([])
  })

  it('parses screencast-frame events', () => {
    const content = '{"type":"screencast-frame","pageId":"p1","sha1":"abc123","width":1920,"height":1080,"timestamp":500}'
    const events = parseJsonl(content)
    expect(events[0]!.type).toBe('screencast-frame')
    if (events[0]!.type === 'screencast-frame') {
      expect(events[0]!.sha1).toBe('abc123')
      expect(events[0]!.width).toBe(1920)
    }
  })
})
