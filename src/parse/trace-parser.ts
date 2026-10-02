import type {
  ParsedTrace,
  TraceAction,
  TraceResource,
  TraceEvent,
  ScreencastFrame,
  CursorPosition,
  FrameReader,
  MonotonicMs,
  TracePage,
  PageUrl,
} from '../types/trace.js'
import { toMonotonic } from '../types/trace.js'
import { ZipReader } from './zip-reader.js'
import { resizedFrameSpansFromJpegs } from './resized-frames.js'
import {
  parseJsonl,
  type ContextOptionsEvent,
  type BeforeActionEvent,
  type AfterActionEvent,
  type InputEvent,
  type ScreencastFrameEvent,
  type ResourceSnapshotEvent,
  type ConsoleEvent,
  type PageLifecycleEvent,
  type FrameSnapshotEvent,
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

  const eventsByFile = traceFiles.map((f) => ({ file: f, events: parseJsonl(zip.readText(f)) }))
  const traceEvents = eventsByFile.flatMap((f) => f.events)
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

  // Only in Chromium are the trace's frames the frames the video records
  const resizedFrames = ctxOpts?.browserName === 'chromium'
    ? resizedFrameSpansFromJpegs(frames, (sha1) => zip.view(`resources/${sha1}`), actions)
    : []

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

  const pages = eventsByFile.flatMap((f) => extractPages(f.events, f.file))
  const baseURLs = new Map<string, string>()
  for (const f of eventsByFile) {
    const base = f.events.find((e): e is ContextOptionsEvent => e.type === 'context-options')?.options?.baseURL
    if (!base) continue
    for (const p of pages) if (p.contextId === f.file) baseURLs.set(p.pageId, base)
  }
  const pageUrls = extractPageUrls(traceEvents, actions, baseURLs)

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
      ...(ctxOpts?.monotonicTime !== undefined ? { wallMonotonicTime: ctxOpts.monotonicTime } : {}),
      playwrightVersion: ctxOpts?.playwrightVersion,
    },
    frames,
    actions,
    resources,
    events,
    cursorPositions,
    resizedFrames,
    pages,
    pageUrls,
    frameReader,
  }
}

function extractPages(events: ReadonlyArray<{ type: string }>, contextId: string): TracePage[] {
  const pages = new Map<string, TracePage>()
  const options = events.find((e): e is ContextOptionsEvent => e.type === 'context-options')?.options
  const page = (pageId: string): TracePage => ({
    pageId,
    contextId,
    ...(options?.viewport ? { viewport: options.viewport } : {}),
  })
  const closedAt = new Map<string, MonotonicMs>()
  for (const raw of events) {
    if (raw.type !== 'event') continue
    const e = raw as PageLifecycleEvent
    if (e.class !== 'BrowserContext' || !e.params?.pageId) continue
    if (e.method === 'page') {
      pages.set(e.params.pageId, {
        ...page(e.params.pageId),
        ...(e.params.openerPageId ? { openerPageId: e.params.openerPageId } : {}),
      })
    } else if (e.method === 'pageClosed') {
      closedAt.set(e.params.pageId, toMonotonic(e.time))
    }
  }
  // A page created before tracing started has no page event, but its frames
  // and calls are in its context's file.
  for (const raw of events) {
    const e = raw as { type: string; class?: string; pageId?: string }
    // Runner entries (test.trace) are not a context's
    const ofContext = e.type === 'screencast-frame' || (e.type === 'before' && e.class !== 'Test')
    if (!e.pageId || !ofContext || pages.has(e.pageId)) continue
    pages.set(e.pageId, page(e.pageId))
  }
  // After both loops: a page created before tracing can close during it
  for (const [pageId, at] of closedAt) {
    const known = pages.get(pageId)
    if (known) known.closedAt = at
  }
  return [...pages.values()]
}

/**
 * Each page's main-frame URL whenever it changes. Snapshots also catch hash
 * routes; a trace without snapshots falls back to goto() targets.
 */
function extractPageUrls(events: ReadonlyArray<{ type: string }>, actions: TraceAction[], baseURLs: ReadonlyMap<string, string>): PageUrl[] {
  const raw: PageUrl[] = []
  for (const event of events) {
    if (event.type !== 'frame-snapshot') continue
    const s = (event as FrameSnapshotEvent).snapshot
    if (!s?.isMainFrame || !s.pageId || !s.frameUrl) continue
    raw.push({ pageId: s.pageId, url: s.frameUrl, timestamp: toMonotonic(s.timestamp) })
  }
  const withSnapshots = new Set(raw.map((u) => u.pageId))
  for (const a of actions) {
    if (a.method !== 'goto' || !a.pageId || withSnapshots.has(a.pageId)) continue
    if (typeof a.params.url !== 'string') continue
    // A goto with baseURL can be relative ('/login'); a host is needed to tell hosts apart.
    let url = a.params.url
    try {
      url = new URL(url, baseURLs.get(a.pageId)).href
    } catch { /* keep as given */ }
    raw.push({ pageId: a.pageId, url, timestamp: a.endTime })
  }
  raw.sort((a, b) => (a.timestamp as number) - (b.timestamp as number))
  const last = new Map<string, string>()
  return raw.filter((u) => {
    if (last.get(u.pageId) === u.url) return false
    last.set(u.pageId, u.url)
    return true
  })
}
