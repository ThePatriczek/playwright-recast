import type { PageUrl } from '../types/trace.js'
import type { UrlBarConfig } from '../types/url-bar.js'

/** A URL bar appearance in trace time, before mapping to the output video. */
export interface UrlBarCue {
  text: string
  startMs: number
  /** Trace time the next cue takes over (`'always'`); else the bar lasts `durationMs`. */
  endMs?: number
}

/** A `showUrl()` marker. */
export interface UrlMarker {
  startMs: number
  url?: string
  durationMs?: number
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Display text for a URL: query stripped, also inside a hash route, and a
 * fragment that is not a route (`#/...`, `#!/...`) dropped, since OAuth's
 * implicit flow returns `#access_token=...`; then redacted. Credentials in
 * the authority (`user:pass@`) never show.
 */
export function formatUrl(
  url: string,
  opts: Pick<UrlBarConfig, 'stripQuery' | 'redact' | 'redactWith'> = {},
): string {
  // Up to the authority's last '@': a password may contain '@' itself
  let text = url.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i, '$1')
  if (opts.stripQuery ?? true) {
    const hash = text.indexOf('#')
    const [base, fragment] = hash >= 0 ? [text.slice(0, hash), text.slice(hash)] : [text, '']
    const route = /^#!?\//.test(fragment) ? fragment.replace(/\?.*$/, '') : ''
    text = base.replace(/\?.*$/, '') + route
  }
  const mask = opts.redactWith ?? '***'
  for (const r of opts.redact ?? []) {
    text = text.replace(typeof r === 'string' ? new RegExp(escapeRegExp(r), 'g') : r, mask)
  }
  return text
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Blank pages have no URL worth showing. */
const isShowable = (url: string): boolean => !url.startsWith('about:')

/** `pageId`'s URL at trace time `t`: the latest at or before it, else its first. */
export function urlAt(pageUrls: ReadonlyArray<PageUrl>, pageId: string, t: number): string | undefined {
  let found: string | undefined
  let first: string | undefined
  for (const u of pageUrls) {
    if (u.pageId !== pageId || !isShowable(u.url)) continue
    first ??= u.url
    if ((u.timestamp as number) <= t) found = u.url
  }
  return found ?? first
}

/** `t`, or the end of the hidden range it falls in. */
function firstVisible(t: number, hidden: ReadonlyArray<{ start: number; end: number }>): number {
  let at = t
  for (const r of [...hidden].sort((a, b) => a.start - b.start)) {
    if (at >= r.start && at < r.end) at = r.end
  }
  return at
}

/**
 * When the URL bar shows, and with which URL, in trace time.
 *
 * The URL is the main-frame URL of the page on screen. Change points (a URL
 * change or another page taking the screen) inside a hidden range count at
 * the range's end, with the URL visible there.
 */
export function buildUrlBarCues(opts: {
  config: UrlBarConfig
  pageUrls: ReadonlyArray<PageUrl>
  activePage: (t: number) => string | undefined
  /** Trace times another page takes the screen. */
  pageSwitches: ReadonlyArray<number>
  markers: ReadonlyArray<UrlMarker>
  hiddenRanges: ReadonlyArray<{ start: number; end: number }>
  startMs: number
  endMs: number
}): UrlBarCue[] {
  const { config, startMs, endMs } = opts
  const show = config.show ?? 'host-change'
  const format = (url: string): string => formatUrl(url, config)
  const urlOn = (t: number): string | undefined => {
    const page = opts.activePage(t)
    return page ? urlAt(opts.pageUrls, page, t) : undefined
  }

  if (show === 'marked') {
    return opts.markers
      .filter((m) => m.startMs >= startMs && m.startMs <= endMs)
      .flatMap((m) => {
        const url = m.url ?? urlOn(m.startMs)
        return url && isShowable(url) ? [{ text: format(url), startMs: m.startMs }] : []
      })
  }

  const hidden = opts.hiddenRanges
  const points = [
    startMs,
    ...opts.pageSwitches,
    ...opts.pageUrls.map((u) => u.timestamp as number),
  ]
    .filter((t) => t >= startMs)
    .map((t) => firstVisible(t, hidden))
    .filter((t) => t <= endMs)
    .sort((a, b) => a - b)
    .filter((t, i, all) => i === 0 || t !== all[i - 1])

  const cues: UrlBarCue[] = []
  if (show === 'always') {
    for (const t of points) {
      const url = urlOn(t)
      if (!url) continue
      const text = format(url)
      const last = cues[cues.length - 1]
      if (last?.text === text) continue
      if (last) last.endMs = t
      cues.push({ text, startMs: t })
    }
    return cues
  }

  // 'host-change': the first visible host is the baseline, not a change.
  let lastHost: string | undefined
  for (const t of points) {
    const url = urlOn(t)
    if (!url) continue
    const h = host(url)
    if (lastHost !== undefined && h !== lastHost) cues.push({ text: format(url), startMs: t })
    lastHost = h
  }
  return cues
}
