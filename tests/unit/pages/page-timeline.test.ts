import { describe, it, expect } from 'vitest'
import {
  activePageAt,
  buildPageTimeline,
  computePageLayouts,
  mapMarkerTitle,
  mapPoint,
  markerPageId,
  primaryPageId,
} from '../../../src/pages/page-timeline'
import { CLICK_TITLE_PREFIX, HIGHLIGHT_TITLE_PREFIX, ZOOM_TITLE_PREFIX } from '../../../src/helpers'
import type { ScreencastFrame, TraceAction, TracePage } from '../../../src/types/trace'
import { toMonotonic } from '../../../src/types/trace'

const frame = (pageId: string, t: number, width = 1280, height = 720): ScreencastFrame =>
  ({ sha1: `${pageId}-${t}`, timestamp: toMonotonic(t), pageId, width, height })

const action = (pageId: string | undefined, t: number, method = 'click'): TraceAction => ({
  callId: `${pageId}-${t}`, title: method, class: 'Frame', method, params: {},
  startTime: toMonotonic(t), endTime: toMonotonic(t + 10), pageId,
})

// The opening time stays in calls for readability; pages have no such field.
const page = (pageId: string, _openedAt: number, closedAt?: number, openerPageId?: string): TracePage => ({
  pageId,
  ...(closedAt !== undefined ? { closedAt: toMonotonic(closedAt) } : {}),
  ...(openerPageId ? { openerPageId } : {}),
})

describe('primaryPageId', () => {
  it('is the page of the last frame', () => {
    expect(primaryPageId([frame('setup', 0), frame('main', 100)])).toBe('main')
  })

  it('walks up to the opener when a popup is still open at the end', () => {
    const pages = [page('main', 0), page('popup', 50, undefined, 'main')]
    expect(primaryPageId([frame('main', 10), frame('popup', 60)], pages)).toBe('main')
  })

  it('stops at an opener without frames', () => {
    const pages = [page('popup', 50, undefined, 'gone')]
    expect(primaryPageId([frame('popup', 60)], pages)).toBe('popup')
  })
})

describe('buildPageTimeline', () => {
  const base = {
    primaryId: 'main',
    firstFrameMs: new Map([['main', 0], ['popup', 1200]]),
    candidates: new Set(['main', 'popup']),
    endMs: 3000,
  }

  it('shows a popup from its first frame until it closes, then its opener', () => {
    const timeline = buildPageTimeline({
      ...base,
      pages: [page('main', 0), page('popup', 1150, 1900, 'main')],
      actions: [action('main', 100), action('main', 1100), action('popup', 1180, 'fill'), action('popup', 1600), action('main', 2400)],
    })
    expect(timeline).toEqual([
      { pageId: 'main', startMs: 0, endMs: 1200 },
      { pageId: 'popup', startMs: 1200, endMs: 1900 },
      { pageId: 'main', startMs: 1900, endMs: 3000 },
    ])
  })

  it('switches to the page of the most recent action', () => {
    const timeline = buildPageTimeline({
      ...base,
      pages: [page('main', 0), page('popup', 1150, undefined, 'main')],
      actions: [action('popup', 1300), action('main', 1500), action('popup', 2000)],
    })
    expect(timeline.map((s) => [s.pageId, s.startMs])).toEqual([['main', 0], ['popup', 1200], ['main', 1500], ['popup', 2000]])
  })

  it('never shows a page without actions', () => {
    const timeline = buildPageTimeline({
      ...base,
      pages: [page('main', 0), page('popup', 1150, 1400, 'main')],
      actions: [action('main', 100), action('main', 2000)],
    })
    expect(timeline).toEqual([{ pageId: 'main', startMs: 0, endMs: 3000 }])
  })

  it('never shows a page without a video', () => {
    const timeline = buildPageTimeline({
      ...base,
      candidates: new Set(['main']),
      pages: [page('main', 0), page('popup', 1150, 1900, 'main')],
      actions: [action('popup', 1300)],
    })
    expect(timeline).toEqual([{ pageId: 'main', startMs: 0, endMs: 3000 }])
  })

  it('falls back to the page active before when the opener is gone', () => {
    const timeline = buildPageTimeline({
      ...base,
      firstFrameMs: new Map([['main', 0], ['tab', 500], ['popup', 1200]]),
      candidates: new Set(['main', 'tab', 'popup']),
      pages: [page('main', 0), page('tab', 500, 1500, 'main'), page('popup', 900, 2000, 'tab')],
      actions: [action('tab', 600), action('popup', 1300)],
    })
    expect(timeline.map((s) => [s.pageId, s.startMs, s.endMs])).toEqual([
      ['main', 0, 500], ['tab', 500, 1200], ['popup', 1200, 2000], ['main', 2000, 3000],
    ])
  })

  it('goes on with the opened tab when the primary page closes', () => {
    const timeline = buildPageTimeline({
      ...base,
      firstFrameMs: new Map([['main', 0], ['tab', 1000]]),
      candidates: new Set(['main', 'tab']),
      pages: [page('main', 0, 1500), page('tab', 900, undefined, 'main')],
      actions: [action('main', 100), action('tab', 1100)],
      endMs: 4000,
    })
    expect(timeline).toEqual([
      { pageId: 'main', startMs: 0, endMs: 1000 },
      { pageId: 'tab', startMs: 1000, endMs: 4000 },
    ])
  })

  it('starts with an earlier page than the primary one', () => {
    // Two context.newPage() pages: the last frame is page 2's.
    const timeline = buildPageTimeline({
      ...base,
      primaryId: 'page2',
      firstFrameMs: new Map([['page1', 200], ['page2', 1000]]),
      candidates: new Set(['page1', 'page2']),
      pages: [page('page1', 100), page('page2', 900)],
      actions: [action('page1', 300), action('page2', 1100)],
    })
    expect(timeline.map((s) => [s.pageId, s.startMs])).toEqual([['page1', 200], ['page2', 1000]])
  })

  it('does not bring a page on screen for close() or for a flicker', () => {
    const timeline = buildPageTimeline({
      ...base,
      pages: [page('main', 0), page('popup', 1150, 2500, 'main')],
      actions: [
        action('popup', 1300), action('main', 1600),
        action('popup', 2000, 'evaluate'), action('main', 2050),
        action('popup', 2490, 'close'),
      ],
    })
    expect(timeline).toEqual([
      { pageId: 'main', startMs: 0, endMs: 1200 },
      { pageId: 'popup', startMs: 1200, endMs: 1600 },
      { pageId: 'main', startMs: 1600, endMs: 3000 },
    ])
  })
})

describe('buildPageTimeline: a short first stretch', () => {
  it('is dropped, not handed to the next page, so the video starts at a page it shows', () => {
    const timeline = buildPageTimeline({
      primaryId: 'main',
      pages: [page('main', 0), page('x', 50)],
      actions: [action('x', 100)],
      firstFrameMs: new Map([['main', 200], ['x', 100]]),
      candidates: new Set(['main', 'x']),
      endMs: 3000,
    })
    expect(timeline).toEqual([{ pageId: 'main', startMs: 200, endMs: 3000 }])
  })
})

describe('activePageAt', () => {
  const timeline = [
    { pageId: 'main', startMs: 0, endMs: 100 },
    { pageId: 'popup', startMs: 100, endMs: 200 },
  ]
  it('finds the segment, clamping outside the timeline', () => {
    expect(activePageAt(timeline, -5)).toBe('main')
    expect(activePageAt(timeline, 100)).toBe('popup')
    expect(activePageAt(timeline, 500)).toBe('popup')
  })
})

type Size = { width: number; height: number }
/** A page as the trace shows it: CSS viewport, and the size its frames' JPEGs were recorded at. */
const pg = (viewport: Size, recorded: Size = viewport) => ({ viewport, recorded })
const vp = { width: 1280, height: 720 }

describe('computePageLayouts', () => {
  it('centers a smaller page at its own size', () => {
    const layout = computePageLayouts('main', new Map([['main', pg(vp)], ['popup', pg({ width: 640, height: 480 })]])).get('popup')!
    expect(layout.crop).toEqual({ width: 640, height: 480 })
    expect(layout.position).toEqual({ x: 320, y: 120 })
    expect(layout.scale).toBe(1)
    expect([layout.offsetX, layout.offsetY]).toEqual([320, 120])
  })

  it('fits a taller page as Playwright recorded it', () => {
    // Measured: an 800x1000 popup records as 576x720 at the top-left.
    const layout = computePageLayouts('main', new Map([['main', pg(vp)], ['popup', pg({ width: 800, height: 1000 }, { width: 576, height: 720 })]])).get('popup')!
    expect(layout.crop).toEqual({ width: 576, height: 720 })
    expect(layout.position).toEqual({ x: 352, y: 0 })
    expect(layout.scale).toBeCloseTo(0.72)
  })

  it('works in CSS pixels when the video records at a device scale', () => {
    // 1920x1080 at scale 2.4: frames at CSS size, JPEGs at 4608x2592.
    const layouts = computePageLayouts('main', new Map([
      ['main', pg({ width: 1920, height: 1080 }, { width: 4608, height: 2592 })],
      ['popup', pg({ width: 1280, height: 1200 }, { width: 2765, height: 2592 })],
    ]))
    const popup = layouts.get('popup')!
    expect(popup.scale).toBeCloseTo(0.9)
    expect(popup.crop).toEqual({ width: 2765, height: 2592 })
    expect(popup.offsetY).toBe(0)
    expect(popup.offsetX).toBeCloseTo((4608 - 2765) / 2 / 2.4, 0)
    expect(layouts.get('main')!.scale).toBe(1)
  })

  it('brings a page Playwright did not scale down to the primary page\'s scale', () => {
    // Measured: default video size 800x450 for a 1280x720 viewport; the 640x480
    // popup records at 600x450, as screencasts scale down to fit but never up.
    const layout = computePageLayouts('main', new Map([['main', pg(vp, { width: 800, height: 450 })], ['popup', pg({ width: 640, height: 480 }, { width: 600, height: 450 })]])).get('popup')!
    expect(layout.crop).toEqual({ width: 600, height: 450 })
    expect(layout.display).toEqual({ width: 400, height: 300 })
    expect(layout.position).toEqual({ x: 200, y: 75 })
    expect(layout.scale).toBe(1)
    expect([layout.offsetX, layout.offsetY]).toEqual([320, 120])
  })

  it('makes the composite the primary page\'s content, rounded down to even', () => {
    // Measured: 1366x768 into an 800x448 video records at 797x448
    const main = computePageLayouts('main', new Map([['main', pg({ width: 1366, height: 768 }, { width: 797, height: 448 })]])).get('main')!
    expect(main.crop).toEqual({ width: 796, height: 448 })
  })
})

describe('computePageLayouts: pages() modes', () => {
  const sizes = new Map([['main', pg(vp)], ['tab', pg(vp)], ['popup', pg({ width: 640, height: 480 })]])

  it('defaults: popups overlay, tabs replace at full size', () => {
    const layouts = computePageLayouts('main', sizes)
    expect(layouts.get('popup')).toMatchObject({ kind: 'popup', mode: 'overlay', display: { width: 640, height: 480 } })
    expect(layouts.get('tab')).toMatchObject({ kind: 'tab', mode: 'replace', display: vp, position: { x: 0, y: 0 }, scale: 1 })
  })

  it('shrinks an overlaid tab and maps its points with it', () => {
    const tab = computePageLayouts('main', sizes, { tab: 'overlay', tabScale: 0.5 }).get('tab')!
    expect(tab).toMatchObject({ mode: 'overlay', display: { width: 640, height: 360 }, position: { x: 320, y: 180 }, scale: 0.5 })
    expect(mapPoint(tab, { x: 1280, y: 720 })).toEqual({ x: 960, y: 540 })
  })

  it('keeps a replacing popup at its own size', () => {
    const popup = computePageLayouts('main', sizes, { popup: 'replace' }).get('popup')!
    expect(popup).toMatchObject({ mode: 'replace', display: { width: 640, height: 480 }, scale: 1 })
  })
})

describe('mapMarkerTitle', () => {
  const layout = computePageLayouts('main', new Map([['main', pg(vp)], ['popup', pg({ width: 640, height: 480 })]])).get('popup')!

  it('moves a highlight box', () => {
    const out = mapMarkerTitle(`${HIGHLIGHT_TITLE_PREFIX}${JSON.stringify({ x: 10, y: 20, width: 100, height: 30, color: '#FF0000' })}`, layout, vp)
    expect(JSON.parse(out.slice(HIGHLIGHT_TITLE_PREFIX.length))).toEqual({ x: 330, y: 140, width: 100, height: 30, color: '#FF0000' })
  })

  it('moves a click point', () => {
    const out = mapMarkerTitle(`${CLICK_TITLE_PREFIX}{"x":0,"y":0}`, layout, vp)
    expect(JSON.parse(out.slice(CLICK_TITLE_PREFIX.length))).toEqual({ x: 320, y: 120 })
  })

  it('moves a zoom center given as viewport fractions', () => {
    const out = mapMarkerTitle(`${ZOOM_TITLE_PREFIX}{"x":0.5,"y":0.5,"level":2}`, layout, vp)
    expect(JSON.parse(out.slice(ZOOM_TITLE_PREFIX.length))).toEqual({ x: 0.5, y: 0.5, level: 2 })
  })

  it('leaves other titles alone', () => {
    expect(mapMarkerTitle('locator.click', layout, vp)).toBe('locator.click')
  })
})

describe('markerPageId', () => {
  const timeline = [{ pageId: 'main', startMs: 0, endMs: 100 }, { pageId: 'popup', startMs: 100, endMs: 200 }]
  it('prefers the pageId in the payload', () => {
    expect(markerPageId(`${CLICK_TITLE_PREFIX}{"x":1,"y":1,"pageId":"main"}`, 150, timeline)).toBe('main')
  })
  it('falls back to the page on screen', () => {
    expect(markerPageId(`${CLICK_TITLE_PREFIX}{"x":1,"y":1}`, 150, timeline)).toBe('popup')
  })
})
