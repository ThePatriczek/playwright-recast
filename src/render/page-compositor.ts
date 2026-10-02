import type { PageLayout, PageSegment } from '../pages/page-timeline.js'
import { runFfmpeg } from '../utils/ffmpeg.js'

/** Opacity of the black layer over the page behind an overlay. */
export const PAGE_BACKDROP_DIM = 0.6

export interface CompositeInput {
  /** The page the frame's size and the output's coordinates come from. */
  primaryId: string
  /** Every page on the timeline, the primary included, each video starting at its first screencast frame. */
  pages: Array<{ pageId: string; video: string; startMs: number; layout: PageLayout }>
  timeline: ReadonlyArray<PageSegment>
  /** Trace time of the output's t=0: the first segment's start. */
  startMs: number
  durationMs: number
  size: { width: number; height: number }
  fps: number
  outputPath: string
  backdrop?: { dim?: number; color?: string }
}

const sec = (ms: number): string => (ms / 1000).toFixed(3)

function enableExpr(windows: Array<[number, number]>): string {
  return windows.map(([a, b]) => `between(t,${sec(a)},${sec(b)})`).join('+')
}

/** A page that takes the whole frame: the primary page or a replacing tab. */
const isFull = (pageId: string, layout: PageLayout, primaryId: string): boolean =>
  pageId === primaryId || (layout.kind === 'tab' && layout.mode === 'replace')

/**
 * ffmpeg args that cut the pages' videos into one video on a black canvas
 * spanning the timeline. A full-frame page (the primary page, a replacing
 * tab) takes the frame while it is on screen. A popup or an overlaid tab
 * shows over the full-frame page that was on screen before it, darkened
 * (`'overlay'`), or over a plain background (`'replace'`). Each page's
 * content is cropped out of its padded video and placed per its layout.
 */
export function buildCompositeArgs(input: CompositeInput): string[] {
  const toVideo = (ms: number): number => ms - input.startMs
  const layoutOf = new Map(input.pages.map((p) => [p.pageId, p.layout]))
  const windows = new Map<string, Array<[number, number]>>()
  const dimWindows: Array<[number, number]> = []
  const plainWindows: Array<[number, number]> = []
  const add = (id: string, w: [number, number]): void => {
    windows.set(id, [...(windows.get(id) ?? []), w])
  }
  let lastFull = input.primaryId
  for (const s of input.timeline) {
    const layout = layoutOf.get(s.pageId)
    const w: [number, number] = [toVideo(s.startMs), toVideo(s.endMs)]
    if (!layout || w[1] <= w[0]) continue
    if (isFull(s.pageId, layout, input.primaryId)) {
      add(s.pageId, w)
      lastFull = s.pageId
      continue
    }
    if (layout.mode === 'overlay') {
      add(lastFull, w)
      dimWindows.push(w)
    } else {
      plainWindows.push(w)
    }
    add(s.pageId, w)
  }

  // Full-frame pages first, then the darkening, then what sits on top.
  const shown = input.pages
    .filter((p) => windows.has(p.pageId))
    .sort((a, b) => Number(!isFull(a.pageId, a.layout, input.primaryId)) - Number(!isFull(b.pageId, b.layout, input.primaryId)))
  const firstOnTop = shown.findIndex((p) => !isFull(p.pageId, p.layout, input.primaryId))

  const { width, height } = input.size
  const args = [
    '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${input.fps}:d=${sec(input.durationMs)}`,
  ]
  for (const p of shown) args.push('-i', p.video)

  const graph: string[] = []
  const dim = input.backdrop?.dim ?? PAGE_BACKDROP_DIM
  const plain = `0x${(input.backdrop?.color ?? '#000000').replace('#', '')}`
  const boxes = (): string =>
    (dimWindows.length > 0 ? `,drawbox=x=0:y=0:w=iw:h=ih:color=black@${dim}:t=fill:enable='${enableExpr(dimWindows)}'` : '') +
    (plainWindows.length > 0 ? `,drawbox=x=0:y=0:w=iw:h=ih:color=${plain}@1:t=fill:enable='${enableExpr(plainWindows)}'` : '')
  let label = '0:v'
  shown.forEach((p, i) => {
    if (i === firstOnTop && (dimWindows.length > 0 || plainWindows.length > 0)) {
      graph.push(`[${label}]null${boxes()}[backdrop]`)
      label = 'backdrop'
    }
    const { crop, display, position } = p.layout
    const scale = display.width !== crop.width || display.height !== crop.height
      ? `,scale=${display.width}:${display.height}` : ''
    graph.push(`[${i + 1}:v]setpts=PTS-STARTPTS+${sec(toVideo(p.startMs))}/TB,crop=${crop.width}:${crop.height}:0:0${scale}[pg${i}]`)
    graph.push(`[${label}][pg${i}]overlay=${position.x}:${position.y}:enable='${enableExpr(windows.get(p.pageId)!)}':eof_action=pass[cmp${i}]`)
    label = `cmp${i}`
  })

  args.push(
    '-filter_complex', graph.join(';'),
    '-map', `[${label}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an',
    input.outputPath,
  )
  return args
}

export function compositePageVideos(input: CompositeInput): void {
  runFfmpeg(buildCompositeArgs(input))
}
