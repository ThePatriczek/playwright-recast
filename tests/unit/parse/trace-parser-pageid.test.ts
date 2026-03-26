import { describe, it, expect } from 'vitest'
import { parseJsonl } from '../../../src/parse/jsonl-parser'
import type { BeforeActionEvent, ScreencastFrameEvent } from '../../../src/parse/jsonl-parser'

describe('JSONL Parser — pageId fields', () => {
  it('parses pageId from BeforeActionEvent', () => {
    const content = JSON.stringify({
      type: 'before',
      callId: 'call-1',
      title: 'locator.click',
      class: 'Locator',
      method: 'click',
      startTime: 1000,
      pageId: 'page@abc123',
    })

    const events = parseJsonl(content)
    expect(events).toHaveLength(1)

    const action = events[0] as BeforeActionEvent
    expect(action.type).toBe('before')
    expect(action.pageId).toBe('page@abc123')
  })

  it('pageId is undefined when not present in BeforeActionEvent', () => {
    const content = JSON.stringify({
      type: 'before',
      callId: 'call-2',
      title: 'locator.fill',
      class: 'Locator',
      method: 'fill',
      startTime: 2000,
    })

    const events = parseJsonl(content)
    const action = events[0] as BeforeActionEvent
    expect(action.pageId).toBeUndefined()
  })

  it('parses pageId from ScreencastFrameEvent', () => {
    const content = JSON.stringify({
      type: 'screencast-frame',
      pageId: 'page@def456',
      sha1: 'frame-sha1',
      width: 1920,
      height: 1080,
      timestamp: 500,
    })

    const events = parseJsonl(content)
    const frame = events[0] as ScreencastFrameEvent
    expect(frame.type).toBe('screencast-frame')
    expect(frame.pageId).toBe('page@def456')
  })

  it('preserves different pageIds across multiple events', () => {
    const lines = [
      JSON.stringify({
        type: 'before',
        callId: 'c1',
        title: 'locator.click',
        class: 'Locator',
        method: 'click',
        startTime: 100,
        pageId: 'page@setup',
      }),
      JSON.stringify({
        type: 'before',
        callId: 'c2',
        title: 'locator.fill',
        class: 'Locator',
        method: 'fill',
        startTime: 200,
        pageId: 'page@recording',
      }),
      JSON.stringify({
        type: 'screencast-frame',
        pageId: 'page@setup',
        sha1: 'f1',
        width: 1280,
        height: 720,
        timestamp: 100,
      }),
      JSON.stringify({
        type: 'screencast-frame',
        pageId: 'page@recording',
        sha1: 'f2',
        width: 1280,
        height: 720,
        timestamp: 500,
      }),
    ].join('\n')

    const events = parseJsonl(lines)
    expect(events).toHaveLength(4)

    const beforeEvents = events.filter((e) => e.type === 'before') as BeforeActionEvent[]
    expect(beforeEvents[0]!.pageId).toBe('page@setup')
    expect(beforeEvents[1]!.pageId).toBe('page@recording')

    const frameEvents = events.filter((e) => e.type === 'screencast-frame') as ScreencastFrameEvent[]
    expect(frameEvents[0]!.pageId).toBe('page@setup')
    expect(frameEvents[1]!.pageId).toBe('page@recording')
  })
})
