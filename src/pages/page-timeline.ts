import type { ScreencastFrame, TraceAction, TracePage } from '../types/trace.js'
import { CLICK_TITLE_PREFIX, HIGHLIGHT_TITLE_PREFIX, ZOOM_TITLE_PREFIX } from '../helpers.js'
import type { PagesConfig } from '../types/pages.js'

/** A stretch of trace time during which one page is on screen. */
export interface PageSegment {
  pageId: string
  startMs: number
  endMs: number
}

type Size = { width: number; height: number }

/**
 * Where a page sits in the composited video. Maps the page's CSS pixels to
 * the primary page's: `primary = offset + page * scale`.
 */
export interface PageLayout {
  pageId: string
  scale: number
  offsetX: number
  offsetY: number
  /** The page's own viewport, CSS pixels. */
  viewport: Size
  /** `'tab'` fills the frame; `'popup'` is smaller. */
  kind: 'popup' | 'tab'
  /** `'overlay'` shows the page behind, darkened; `'replace'` hides it. */
  mode: 'overlay' | 'replace'
  /** Content area at the top-left of the page's video; Playwright pads the rest gray. */
  crop: Size
  /** Size of the content in the composited video, video pixels. */
  display: Size
  /** Top-left of the content in the composited video, video pixels. */
  position: { x: number; y: number }
}

/**
 * The page the video is built around and timed from: the page of the last
 * screencast frame (a setup context comes first), or the page that opened it
 * and so on up, also when the opener closed before the end, as the video
 * starts with the opener.
 */
export function primaryPageId(
  frames: ReadonlyArray<ScreencastFrame>,
  pages: ReadonlyArray<TracePage> = [],
): string | undefined {
  let id = frames[frames.length - 1]?.pageId
  const byId = new Map(pages.map((p) => [p.pageId, p]))
  const withFrames = new Set(frames.map((f) => f.pageId))
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const opener = byId.get(id)?.openerPageId
    if (!opener || !withFrames.has(opener)) break
    id = opener
  }
  return id
}

/** Shorter stretches on screen are flicker, e.g. an action on a page about to close. */
export const MIN_PAGE_SEGMENT_MS = 150

/**
 * Which page is on screen when. The page of the most recent action is, from
 * its first frame on; the primary page shows from its first frame even
 * without actions. When the page on screen closes, its opener (else the page
 * active before it) takes over. Pages without actions never show, a
 * `close()` call does not bring a page on screen, and stretches shorter than
 * {@link MIN_PAGE_SEGMENT_MS} go to the page before them.
 */
export function buildPageTimeline(opts: {
  primaryId: string
  pages: ReadonlyArray<TracePage>
  actions: ReadonlyArray<TraceAction>
  /** First screencast frame per page; also its video's t=0. */
  firstFrameMs: ReadonlyMap<string, number>
  /** Pages that can be shown: with a video and frames. */
  candidates: ReadonlySet<string>
  endMs: number
}): PageSegment[] {
  const { primaryId, endMs } = opts
  const pages = new Map(opts.pages.map((p) => [p.pageId, p]))
  const shown = (id: string): boolean =>
    opts.firstFrameMs.has(id) && (id === primaryId || opts.candidates.has(id))

  type Ev = { t: number; kind: 'activate' | 'close'; pageId: string }
  const events: Ev[] = []
  const withActions = new Set<string>([primaryId])
  for (const a of opts.actions) {
    if (!a.pageId || !shown(a.pageId) || a.method === 'close') continue
    withActions.add(a.pageId)
    events.push({ t: Math.max(a.startTime as number, opts.firstFrameMs.get(a.pageId)!), kind: 'activate', pageId: a.pageId })
  }
  for (const id of withActions) {
    const first = opts.firstFrameMs.get(id)
    if (first === undefined) continue
    events.push({ t: first, kind: 'activate', pageId: id })
    const closedAt = pages.get(id)?.closedAt
    if (closedAt !== undefined) events.push({ t: closedAt as number, kind: 'close', pageId: id })
  }
  // A close at the same instant as an action on the closing page wins.
  events.sort((a, b) => a.t - b.t || (a.kind === b.kind ? 0 : a.kind === 'close' ? -1 : 1))

  const closed = new Set<string>()
  const recency: string[] = []
  const segments: PageSegment[] = []
  let active: string | undefined
  let since = 0
  const switchTo = (id: string, t: number): void => {
    if (id === active) return
    const at = Math.min(t, endMs)
    if (active !== undefined && at > since) segments.push({ pageId: active, startMs: since, endMs: at })
    active = id
    since = Math.max(since, at)
  }

  for (const ev of events) {
    if (ev.kind === 'close') {
      closed.add(ev.pageId)
      if (active === ev.pageId) {
        const opener = pages.get(ev.pageId)?.openerPageId
        const next = opener && shown(opener) && !closed.has(opener)
          ? opener
          : [...recency].reverse().find((id) => !closed.has(id))
        // Nothing left open: the last page stays, frozen on its last frame.
        if (next) switchTo(next, ev.t)
      }
      continue
    }
    if (closed.has(ev.pageId)) continue
    recency.splice(0, recency.length, ...recency.filter((id) => id !== ev.pageId), ev.pageId)
    if (active === undefined) since = ev.t
    switchTo(ev.pageId, ev.t)
  }
  if (active !== undefined && endMs > since) segments.push({ pageId: active, startMs: since, endMs })

  // Flicker goes to the stretch before it. One at the start is dropped: the
  // stretch after starts at its page's own first frame or later, and handing
  // it the earlier start would time the video from a page it never shows.
  const kept: PageSegment[] = []
  for (const s of segments) {
    const last = kept[kept.length - 1]
    if (last && s.endMs - s.startMs < MIN_PAGE_SEGMENT_MS) last.endMs = s.endMs
    else if (last && last.pageId === s.pageId) last.endMs = s.endMs
    else kept.push({ ...s })
  }
  if (kept.length > 1 && kept[0]!.endMs - kept[0]!.startMs < MIN_PAGE_SEGMENT_MS) kept.shift()
  return kept
}

/** The page on screen at `t`; the first segment's page before it, the last's after it. */
export function activePageAt(timeline: ReadonlyArray<PageSegment>, t: number): string | undefined {
  for (const s of timeline) if (t < s.endMs) return s.pageId
  return timeline[timeline.length - 1]?.pageId
}

/** Rounded down to even, as libx264's yuv420p needs. */
export const evenDown = (size: Size): Size => ({ width: size.width - (size.width % 2), height: size.height - (size.height % 2) })

/**
 * Layout of every page in the composited video, which is the primary page's
 * recorded content (its padding cut off). Each other page's content is cut
 * out of its padded video, brought to the primary page's scale and centered,
 * so a popup keeps its size relative to the primary page; one larger than
 * the primary page is fitted, and an overlaid tab shrinks to `tabScale`.
 *
 * @param pages Per page: its viewport in CSS pixels and the size its content
 *   was recorded at in its video (top-left, the rest gray padding), at one
 *   CSS-to-pixel ratio for both axes.
 */
export function computePageLayouts(
  primaryId: string,
  pages: ReadonlyMap<string, { viewport: Size; recorded: Size }>,
  config: PagesConfig = {},
): Map<string, PageLayout> {
  const layouts = new Map<string, PageLayout>()
  const primary = pages.get(primaryId)
  if (!primary) return layouts
  const area = evenDown(primary.recorded)
  const videoPxPerCss = primary.recorded.width / primary.viewport.width
  const even = (v: number): number => 2 * Math.round(v / 2)

  for (const [pageId, { viewport, recorded }] of pages) {
    if (pageId === primaryId) {
      layouts.set(pageId, {
        pageId, scale: 1, offsetX: 0, offsetY: 0,
        viewport,
        kind: 'tab',
        mode: 'replace',
        crop: area,
        display: area,
        position: { x: 0, y: 0 },
      })
      continue
    }
    const crop = recorded
    // At the primary page's scale, fitted into its content
    const fit = Math.min(1, area.width / (viewport.width * videoPxPerCss), area.height / (viewport.height * videoPxPerCss))
    const fitted = { width: viewport.width * videoPxPerCss * fit, height: viewport.height * videoPxPerCss * fit }
    // A pixel or two short of the frame is rounding, still a tab
    const kind = fitted.width >= area.width - 2 && fitted.height >= area.height - 2 ? 'tab' : 'popup'
    const mode = kind === 'tab' ? config.tab ?? 'replace' : config.popup ?? 'overlay'
    const shrink = kind === 'tab' && mode === 'overlay' ? config.tabScale ?? 0.85 : 1
    const target = { width: Math.min(area.width, Math.round(fitted.width * shrink)), height: Math.min(area.height, Math.round(fitted.height * shrink)) }
    // Even when scaled, so the composited yuv420 video keeps whole chroma samples
    const display = target.width === crop.width && target.height === crop.height
      ? crop
      : { width: Math.min(area.width, even(target.width)), height: Math.min(area.height, even(target.height)) }
    const position = {
      x: Math.round((area.width - display.width) / 2),
      y: Math.round((area.height - display.height) / 2),
    }
    layouts.set(pageId, {
      pageId,
      scale: display.width / (viewport.width * videoPxPerCss),
      offsetX: position.x / videoPxPerCss,
      offsetY: position.y / videoPxPerCss,
      viewport,
      kind,
      mode,
      crop,
      display,
      position,
    })
  }
  return layouts
}

/** A page point in primary-page CSS pixels. */
export function mapPoint(layout: PageLayout, p: { x: number; y: number }): { x: number; y: number } {
  return { x: layout.offsetX + p.x * layout.scale, y: layout.offsetY + p.y * layout.scale }
}

/**
 * Move a `highlight()`, `zoom()` or `markClick()` marker into primary-page
 * coordinates. Other titles come back unchanged.
 */
export function mapMarkerTitle(
  title: string,
  layout: PageLayout,
  primaryViewport: Size,
): string {
  const remap = (prefix: string, fn: (d: Record<string, unknown>) => void): string | undefined => {
    if (!title.startsWith(prefix)) return undefined
    try {
      const data = JSON.parse(title.slice(prefix.length)) as Record<string, unknown>
      fn(data)
      return prefix + JSON.stringify(data)
    } catch {
      return title
    }
  }
  const num = (v: unknown): v is number => typeof v === 'number'
  return remap(HIGHLIGHT_TITLE_PREFIX, (d) => {
    if (!num(d.x) || !num(d.y) || !num(d.width) || !num(d.height)) return
    const p = mapPoint(layout, { x: d.x, y: d.y })
    d.x = p.x
    d.y = p.y
    d.width = d.width * layout.scale
    d.height = d.height * layout.scale
  }) ?? remap(CLICK_TITLE_PREFIX, (d) => {
    if (!num(d.x) || !num(d.y)) return
    const p = mapPoint(layout, { x: d.x, y: d.y })
    d.x = p.x
    d.y = p.y
  }) ?? remap(ZOOM_TITLE_PREFIX, (d) => {
    // Viewport fractions
    if (!num(d.x) || !num(d.y)) return
    const p = mapPoint(layout, { x: d.x * layout.viewport.width, y: d.y * layout.viewport.height })
    d.x = p.x / primaryViewport.width
    d.y = p.y / primaryViewport.height
  }) ?? title
}

/** Page a marker belongs to: its own `pageId`, else the page on screen at its time. */
export function markerPageId(title: string, startMs: number, timeline: ReadonlyArray<PageSegment>): string | undefined {
  const json = title.indexOf('{')
  if (json >= 0) {
    try {
      const data = JSON.parse(title.slice(json)) as { pageId?: unknown }
      if (typeof data.pageId === 'string') return data.pageId
    } catch { /* fall through */ }
  }
  return activePageAt(timeline, startMs)
}
