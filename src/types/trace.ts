/** Monotonic timestamp in milliseconds (trace-internal clock). Branded to prevent mixing with wall clock. */
export type MonotonicMs = number & { readonly __brand: 'MonotonicMs' }

export function toMonotonic(ms: number): MonotonicMs {
  return ms as MonotonicMs
}

/** A screencast frame captured in the trace */
export interface ScreencastFrame {
  sha1: string
  timestamp: MonotonicMs
  pageId: string
  width: number
  height: number
}

/** Cursor position from an 'input' trace event */
export interface CursorPosition {
  x: number
  y: number
  timestamp: MonotonicMs
}

/** Well-known annotation types used by playwright-recast helpers and the reporter */
export type KnownAnnotationType = 'voiceover' | 'voiceover-hidden' | 'zoom' | 'demo-uid' | 'demo-persona' | 'demo-video-path'

/** Annotation attached to a trace action (e.g. from playwright-bdd) */
export interface TraceAnnotation {
  type: KnownAnnotationType | (string & {})
  description?: string
}

/** A Playwright action extracted from the trace */
export interface TraceAction {
  callId: string
  stepId?: string
  title: string
  class: string
  method: string
  params: Record<string, unknown>
  startTime: MonotonicMs
  endTime: MonotonicMs
  parentId?: string
  error?: { message: string }
  point?: CursorPosition
  annotations?: TraceAnnotation[]
  /** BDD step keyword (Given/When/Then/And/But) — populated by bdd-extractor */
  keyword?: string
  /** BDD step text — populated by bdd-extractor */
  text?: string
  /** BDD doc string (voiceover text) — populated by bdd-extractor */
  docString?: string
}

/** A network resource captured in the trace */
export interface TraceResource {
  url: string
  method: string
  status: number
  startTime: MonotonicMs
  endTime: MonotonicMs
  mimeType: string
  requestSize?: number
  responseSize?: number
}

/** A console or page event */
export interface TraceEvent {
  type: 'console' | 'event'
  time: MonotonicMs
  method?: string
  pageId?: string
  text?: string
}

/** Abstraction for reading frame JPEG data from the trace zip */
export interface FrameReader {
  readFrame(sha1: string): Promise<Buffer>
  dispose(): void
}

/** The complete parsed trace — output of .parse() */
export interface ParsedTrace {
  metadata: {
    browserName: string
    platform: string
    viewport: { width: number; height: number }
    startTime: MonotonicMs
    endTime: MonotonicMs
    wallTime: number
    playwrightVersion?: string
  }
  frames: ScreencastFrame[]
  actions: TraceAction[]
  resources: TraceResource[]
  events: TraceEvent[]
  cursorPositions: CursorPosition[]
  frameReader: FrameReader
}

/** Trace after hidden steps have been filtered out */
export interface FilteredTrace extends ParsedTrace {
  originalActions: TraceAction[]
  hiddenRanges: Array<{ start: MonotonicMs; end: MonotonicMs }>
}
