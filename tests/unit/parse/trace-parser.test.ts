import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { parseTrace } from '../../../src/parse/trace-parser'

const TRACE_PATH = path.resolve(__dirname, '../../fixtures/demo-trace.zip')

describe('TraceParser (integration with real trace)', () => {
  it('parses a real trace zip into ParsedTrace', async () => {
    const trace = await parseTrace(TRACE_PATH)

    expect(trace.metadata.browserName).toBeDefined()
    expect(trace.metadata.viewport.width).toBeGreaterThan(0)
    expect(trace.metadata.playwrightVersion).toBeDefined()
  })

  it('extracts actions with start/end times', async () => {
    const trace = await parseTrace(TRACE_PATH)

    expect(trace.actions.length).toBeGreaterThan(0)

    const firstAction = trace.actions[0]!
    expect(firstAction.callId).toBeDefined()
    expect(firstAction.title).toBeDefined()
    expect(firstAction.startTime).toBeGreaterThanOrEqual(0)
    expect(firstAction.endTime).toBeGreaterThanOrEqual(firstAction.startTime)
  })

  it('extracts screencast frames', async () => {
    const trace = await parseTrace(TRACE_PATH)

    expect(trace.frames.length).toBeGreaterThan(0)

    const firstFrame = trace.frames[0]!
    expect(firstFrame.sha1).toBeDefined()
    expect(firstFrame.width).toBeGreaterThan(0)
    expect(firstFrame.height).toBeGreaterThan(0)
    expect(firstFrame.timestamp).toBeGreaterThanOrEqual(0)
  })

  it('can read frame data from the zip', async () => {
    const trace = await parseTrace(TRACE_PATH)

    if (trace.frames.length > 0) {
      const firstFrame = trace.frames[0]!
      const data = await trace.frameReader.readFrame(firstFrame.sha1)
      expect(data.length).toBeGreaterThan(0)
      // JPEG files start with FF D8
      expect(data[0]).toBe(0xff)
      expect(data[1]).toBe(0xd8)
    }

    trace.frameReader.dispose()
  })

  it('extracts network resources', async () => {
    const trace = await parseTrace(TRACE_PATH)

    // Demo trace should have network activity
    expect(trace.resources.length).toBeGreaterThan(0)

    const resource = trace.resources[0]!
    expect(resource.url).toBeDefined()
    expect(resource.method).toBeDefined()
  })

  it('frames are sorted by timestamp', async () => {
    const trace = await parseTrace(TRACE_PATH)

    for (let i = 1; i < trace.frames.length; i++) {
      expect(trace.frames[i]!.timestamp).toBeGreaterThanOrEqual(
        trace.frames[i - 1]!.timestamp,
      )
    }

    trace.frameReader.dispose()
  })

  it('actions are sorted by start time', async () => {
    const trace = await parseTrace(TRACE_PATH)

    for (let i = 1; i < trace.actions.length; i++) {
      expect(trace.actions[i]!.startTime).toBeGreaterThanOrEqual(
        trace.actions[i - 1]!.startTime,
      )
    }
  })
})
