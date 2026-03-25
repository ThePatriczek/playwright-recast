/** Raw trace event as parsed from JSONL */
export type TraceEventRaw =
  | ContextOptionsEvent
  | BeforeActionEvent
  | AfterActionEvent
  | InputEvent
  | ScreencastFrameEvent
  | ResourceSnapshotEvent
  | ConsoleEvent
  | GenericEvent

export interface ContextOptionsEvent {
  type: 'context-options'
  browserName?: string
  platform?: string
  options?: {
    viewport?: { width: number; height: number }
  }
  wallTime?: number
  monotonicTime?: number
  playwrightVersion?: string
}

export interface BeforeActionEvent {
  type: 'before'
  callId: string
  stepId?: string
  title: string
  class: string
  method: string
  params?: Record<string, unknown>
  startTime: number
  pageId?: string
  parentId?: string
  stack?: unknown
}

export interface AfterActionEvent {
  type: 'after'
  callId: string
  endTime: number
  error?: { message: string }
  result?: unknown
  point?: { x: number; y: number }
}

export interface InputEvent {
  type: 'input'
  callId: string
  point?: { x: number; y: number }
}

export interface ScreencastFrameEvent {
  type: 'screencast-frame'
  pageId: string
  sha1: string
  width: number
  height: number
  timestamp: number
}

export interface ResourceSnapshotEvent {
  type: 'resource-snapshot'
  snapshot: {
    request: { url: string; method: string }
    response: { status: number; mimeType?: string }
    startedDateTime: string
    time: number
    _monotonicTime?: number
  }
}

export interface ConsoleEvent {
  type: 'console'
  time: number
  text?: string
  pageId?: string
}

export interface GenericEvent {
  type: string
  [key: string]: unknown
}

/** Parse a JSONL string into typed trace events, skipping malformed lines */
export function parseJsonl(content: string): TraceEventRaw[] {
  const events: TraceEventRaw[] = []

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as TraceEventRaw)
    } catch {
      // Skip malformed lines
    }
  }

  return events
}
