import type {
  ParsedTrace,
  TraceAction,
  TraceResource,
  TraceEvent,
  ScreencastFrame,
  CursorPosition,
  FrameReader,
  MonotonicMs,
} from '../types/trace.js'
import { toMonotonic } from '../types/trace.js'
import { ZipReader } from './zip-reader.js'
import {
  parseJsonl,
  type ContextOptionsEvent,
  type BeforeActionEvent,
  type AfterActionEvent,
  type InputEvent,
  type ScreencastFrameEvent,
  type ResourceSnapshotEvent,
  type ConsoleEvent,
} from './jsonl-parser.js'

/**
 * Parse a Playwright trace zip into structured data.
 */
export async function parseTrace(tracePath: string): Promise<ParsedTrace> {
  const zip = ZipReader.open(tracePath)
  const entries = zip.entryNames()

  // Parse ALL trace and network JSONL files (multiple contexts in one zip)
  const traceFiles = entries.filter((n) => n.endsWith('.trace'))
  const networkFiles = entries.filter((n) => n.endsWith('.network'))

  const traceEvents = traceFiles.flatMap((f) => parseJsonl(zip.readText(f)))
  const networkEvents = networkFiles.flatMap((f) => parseJsonl(zip.readText(f)))

  // Find the most informative context-options event (one with browserName set)
  const ctxOptsAll = traceEvents.filter(
    (e): e is ContextOptionsEvent => e.type === 'context-options',
  )
  const ctxOpts =
    ctxOptsAll.find((e) => e.browserName && e.browserName.length > 0) ??
    ctxOptsAll[0]

  // Build action map: before + after events paired by callId
  const actionStarts = new Map<string, BeforeActionEvent>()
  const actionEnds = new Map<string, AfterActionEvent>()
  const inputPoints = new Map<string, { x: number; y: number }>()

  for (const event of traceEvents) {
    switch (event.type) {
      case 'before': {
        const e = event as BeforeActionEvent
        actionStarts.set(e.callId, e)
        break
      }
      case 'after': {
        const e = event as AfterActionEvent
        actionEnds.set(e.callId, e)
        break
      }
      case 'input': {
        const e = event as InputEvent
        if (e.point) inputPoints.set(e.callId, e.point)
        break
      }
    }
  }

  // Build actions
  const actions: TraceAction[] = []
  for (const [callId, start] of actionStarts) {
    const end = actionEnds.get(callId)
    const point = inputPoints.get(callId)
    actions.push({
      callId,
      stepId: start.stepId,
      title: start.title,
      class: start.class,
      method: start.method,
      params: start.params ?? {},
      startTime: toMonotonic(start.startTime),
      endTime: toMonotonic(end?.endTime ?? start.startTime),
      parentId: start.parentId,
      pageId: start.pageId,
      error: end?.error,
      point: point
        ? { x: point.x, y: point.y, timestamp: toMonotonic(start.startTime) }
        : undefined,
    })
  }
  actions.sort((a, b) => (a.startTime as number) - (b.startTime as number))

  // Extract screencast frames
  const frames: ScreencastFrame[] = traceEvents
    .filter((e): e is ScreencastFrameEvent => e.type === 'screencast-frame')
    .map((e) => ({
      sha1: e.sha1,
      timestamp: toMonotonic(e.timestamp),
      pageId: e.pageId,
      width: e.width,
      height: e.height,
    }))
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))

  // Extract network resources
  const resources: TraceResource[] = networkEvents
    .filter((e): e is ResourceSnapshotEvent => e.type === 'resource-snapshot')
    .map((e) => {
      const s = e.snapshot
      const startTime = s._monotonicTime ?? 0
      return {
        url: s.request.url,
        method: s.request.method,
        status: s.response.status,
        startTime: toMonotonic(startTime),
        endTime: toMonotonic(startTime + (s.time ?? 0)),
        mimeType: s.response.mimeType ?? '',
      }
    })

  // Extract cursor positions from input events
  const cursorPositions: CursorPosition[] = []
  for (const [callId, point] of inputPoints) {
    const start = actionStarts.get(callId)
    if (start) {
      cursorPositions.push({
        x: point.x,
        y: point.y,
        timestamp: toMonotonic(start.startTime),
      })
    }
  }
  cursorPositions.sort(
    (a, b) => (a.timestamp as number) - (b.timestamp as number),
  )

  // Extract console/page events
  const events: TraceEvent[] = traceEvents
    .filter(
      (e): e is ConsoleEvent =>
        e.type === 'console' || e.type === 'event',
    )
    .map((e) => ({
      type: e.type as 'console' | 'event',
      time: toMonotonic(e.time),
      pageId: e.pageId,
      text: e.text,
    }))

  // Compute time boundaries
  const allTimes = [
    ...actions.map((a) => a.startTime as number),
    ...actions.map((a) => a.endTime as number),
    ...frames.map((f) => f.timestamp as number),
  ].filter((t) => t > 0)
  const startTime = allTimes.length > 0 ? Math.min(...allTimes) : 0
  const endTime = allTimes.length > 0 ? Math.max(...allTimes) : 0

  // Create frame reader
  const frameReader: FrameReader = {
    readFrame(sha1: string): Promise<Buffer> {
      const name = `resources/${sha1}`
      return Promise.resolve(zip.readBinary(name))
    },
    dispose() {
      zip.dispose()
    },
  }

  return {
    metadata: {
      browserName: ctxOpts?.browserName ?? 'unknown',
      platform: ctxOpts?.platform ?? 'unknown',
      viewport: ctxOpts?.options?.viewport ?? { width: 1920, height: 1080 },
      startTime: toMonotonic(startTime),
      endTime: toMonotonic(endTime),
      wallTime: ctxOpts?.wallTime ?? 0,
      playwrightVersion: ctxOpts?.playwrightVersion,
    },
    frames,
    actions,
    resources,
    events,
    cursorPositions,
    frameReader,
  }
}
