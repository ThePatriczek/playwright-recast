/** Monotonic timestamp in milliseconds (trace-internal clock). Branded to prevent mixing with wall clock. */
export type MonotonicMs = number & { readonly __brand: 'MonotonicMs' }

export function toMonotonic(ms: number): MonotonicMs {
  return ms as MonotonicMs
}

/** A screencast frame captured in the trace */
export interface ScreencastFrame {
  /** The image's key for FrameReader: its resource sha1, or its zip path (Playwright 1.63+) */
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
  /** Playwright page ID this action belongs to */
  pageId?: string
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

/** A page's lifetime, from the trace's BrowserContext page events */
export interface TracePage {
  pageId: string
  /** Page that opened it (window.open, target=_blank) */
  openerPageId?: string
  closedAt?: MonotonicMs
  /** Trace file of the page's browser context; one per context */
  contextId?: string
  /** Viewport of the page's context (context option), CSS pixels */
  viewport?: { width: number; height: number }
}

/** A page's main-frame URL from a DOM snapshot */
export interface PageUrl {
  pageId: string
  url: string
  timestamp: MonotonicMs
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
    /** Monotonic time at `wallTime` */
    wallMonotonicTime?: number
    playwrightVersion?: string
  }
  frames: ScreencastFrame[]
  actions: TraceAction[]
  resources: TraceResource[]
  events: TraceEvent[]
  cursorPositions: CursorPosition[]
  /** Spans a page was rendered at another size (see resizedFrameSpans()); Chromium only */
  resizedFrames?: Array<{ pageId: string; start: MonotonicMs; end: MonotonicMs }>
  /** Page lifetimes; absent in traces parsed by older versions or built by hand */
  pages?: TracePage[]
  /** Main-frame URL changes per page, from snapshots (or goto calls without them) */
  pageUrls?: PageUrl[]
  frameReader: FrameReader
}

/** Trace after hidden steps have been filtered out */
export interface FilteredTrace extends ParsedTrace {
  originalActions: TraceAction[]
  hiddenRanges: Array<{ start: MonotonicMs; end: MonotonicMs }>
}
