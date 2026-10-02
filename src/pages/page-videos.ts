import * as fs from 'node:fs'
import * as path from 'node:path'
import { PAGES_TITLE_PREFIX } from '../helpers.js'
import type { TraceAction } from '../types/trace.js'

/** Playwright's raw `recordVideo` file name: the trace's pageId plus `.webm`. */
const PAGE_VIDEO = /^(page@[0-9a-f]+)\.webm$/
/** Playwright Test's video names: `video.webm`, `video-N.webm`. */
const TEST_VIDEO = /^video(-\d+)?\.webm$/

/**
 * Order of preference within one directory: `video.webm` (the first page),
 * other names, `video-N.webm` by number, `page@` files. By name alone,
 * `video-1` would sort before `video`.
 */
function rank(file: string): [number, number, string] {
  const test = TEST_VIDEO.exec(file)
  if (test) return test[1] ? [2, Number(test[1].slice(1)), file] : [0, 0, file]
  if (PAGE_VIDEO.test(file)) return [3, 0, file]
  return [1, 0, file]
}

const byRank = (a: string, b: string): number => {
  const [ra, na, fa] = rank(a)
  const [rb, nb, fb] = rank(b)
  return ra - rb || na - nb || fa.localeCompare(fb)
}

/** Subdirectories to search, skipping dot-directories (recast's own temp dirs). */
function subdirs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort()
}

/** The preferred .webm in `dir`, else in its subdirectories, depth first. */
export function findSourceVideo(dir: string): string | undefined {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return undefined
  const own = fs.readdirSync(dir).filter((f) => f.endsWith('.webm')).sort(byRank)
  if (own.length > 0) return path.join(dir, own[0]!)
  for (const sub of subdirs(dir)) {
    const found = findSourceVideo(sub)
    if (found) return found
  }
  return undefined
}

/** The page ids of the last `recastPageVideos` step, one per Playwright Test video. */
export function testVideoPages(actions: ReadonlyArray<Pick<TraceAction, 'title'>>): Array<string | null> | undefined {
  for (let i = actions.length - 1; i >= 0; i--) {
    const title = actions[i]!.title
    if (typeof title !== 'string' || !title.startsWith(PAGES_TITLE_PREFIX)) continue
    try {
      const ids: unknown = JSON.parse(title.slice(PAGES_TITLE_PREFIX.length))
      if (Array.isArray(ids)) return ids.map((id) => (typeof id === 'string' ? id : null))
    } catch { /* malformed: as if absent */ }
  }
  return undefined
}

/**
 * Every page's video, by pageId: `page@<pageId>.webm` in `dir` and its
 * subdirectories, and `dir`'s own `video.webm` / `video-N.webm` as entry
 * 0 / N of `ids` (testVideoPages()).
 */
export function findPageVideos(dir: string, ids?: ReadonlyArray<string | null>): Map<string, string> {
  const videos = new Map<string, string>()
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return videos
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d).sort()) {
      const m = PAGE_VIDEO.exec(f)
      if (m && !videos.has(m[1]!)) videos.set(m[1]!, path.join(d, f))
    }
    for (const sub of subdirs(d)) walk(sub)
  }
  walk(dir)
  if (ids) {
    for (const f of fs.readdirSync(dir)) {
      const m = TEST_VIDEO.exec(f)
      const id = m ? ids[m[1] ? Number(m[1].slice(1)) : 0] : undefined
      if (id && !videos.has(id)) videos.set(id, path.join(dir, f))
    }
  }
  return videos
}
