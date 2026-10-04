import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildCompositeArgs, compositePageVideos, PAGE_BACKDROP_DIM } from '../../../src/render/page-compositor'
import { computePageLayouts } from '../../../src/pages/page-timeline'

const vp = { width: 1280, height: 720 }
const pages = (sizes: Map<string, { width: number; height: number }>) => new Map([...sizes].map(([id, size]) => [id, { viewport: size, recorded: size }]))

function graphOf(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1]!
}

describe('compositePageVideos: closed background page', () => {
  it.each(['popup', 'tab'] as const)('holds the final background frame under an overlaid %s until the next page takes over', (kind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-closed-background-'))
    try {
      const size = { width: 64, height: 48 }
      const overlaySize = kind === 'popup' ? { width: 32, height: 24 } : size
      const sizes = new Map([['main', size], ['overlay', overlaySize], ['next', size]])
      const layouts = computePageLayouts('main', pages(sizes), { tab: 'overlay', tabScale: 0.5 })
      // The next page replaces the whole frame after the overlay is done.
      const nextLayout = computePageLayouts('main', pages(sizes)).get('next')!
      layouts.set('next', nextLayout)
      const colors = ['red', 'blue', 'green']
      const ids = ['main', 'overlay', 'next']
      for (const [i, id] of ids.entries()) {
        const s = sizes.get(id)!
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colors[i]}:s=${s.width}x${s.height}:r=25:d=${id === 'overlay' ? 3 : 1}`, '-c:v', 'libvpx', path.join(dir, `${id}.webm`)])
      }
      const output = path.join(dir, 'out.mp4')
      compositePageVideos({
        primaryId: 'main',
        pages: ids.map((id, i) => ({ pageId: id, video: path.join(dir, `${id}.webm`), startMs: [0, 500, 3000][i]!, layout: layouts.get(id)! })),
        timeline: [
          { pageId: 'main', startMs: 0, endMs: 500 },
          { pageId: 'overlay', startMs: 500, endMs: 3000 },
          { pageId: 'next', startMs: 3000, endMs: 4000 },
        ],
        startMs: 0, durationMs: 4000, size, fps: 25, outputPath: output,
      })
      const pixel = (t: number, x = 0, y = 0): number[] => [...execFileSync('ffmpeg', [
        '-v', 'error', '-ss', String(t), '-i', output, '-frames:v', '1',
        '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ]).subarray(0, 3)]
      const beforeClose = pixel(0.75)
      const afterClose = pixel(2)
      expect(beforeClose[0]).toBeGreaterThan(10)
      expect(afterClose).toHaveLength(3)
      afterClose.forEach((value, i) => expect(Math.abs(value - beforeClose[i]!)).toBeLessThan(8))
      // The overlay still plays, and neither frozen layer obscures the next page.
      expect(pixel(2, 32, 24)[2]).toBeGreaterThan(150)
      expect(pixel(3.75, 32, 24)[1]).toBeGreaterThan(90)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildCompositeArgs', () => {
  const layouts = computePageLayouts('main', pages(new Map([['main', vp], ['popup', { width: 640, height: 480 }]])))
  const args = buildCompositeArgs({
    primaryId: 'main',
    pages: [
      { pageId: 'main', video: 'main.webm', startMs: 1000, layout: layouts.get('main')! },
      { pageId: 'popup', video: 'popup.webm', startMs: 2200, layout: layouts.get('popup')! },
    ],
    timeline: [
      { pageId: 'main', startMs: 1000, endMs: 2200 },
      { pageId: 'popup', startMs: 2200, endMs: 2900 },
      { pageId: 'main', startMs: 2900, endMs: 4000 },
    ],
    startMs: 1000,
    durationMs: 3000,
    size: vp,
    fps: 25,
    outputPath: 'out.mp4',
  })
  const graph = graphOf(args)

  it('lays the pages over a black canvas as long as the timeline', () => {
    expect(args.slice(0, 5)).toEqual(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=25:d=3.000'])
    expect(args.filter((a) => a.endsWith('.webm'))).toEqual(['main.webm', 'popup.webm'])
  })

  it('shows the primary page while on screen and behind the popup', () => {
    expect(graph).toContain("[0:v][pg0]overlay=0:0:enable='between(t,0.000,1.200)+between(t,1.200,1.900)+between(t,1.900,3.000)'")
  })

  it('dims it while the popup shows', () => {
    expect(graph).toContain(`color=black@${PAGE_BACKDROP_DIM}:t=fill:enable='between(t,1.200,1.900)'`)
  })

  it('starts the popup video at its first frame, cropped and centered on top', () => {
    expect(graph).toContain('[2:v]setpts=PTS-STARTPTS+1.200/TB,crop=640:480:0:0[pg1]')
    expect(graph).toContain("[backdrop][pg1]overlay=320:120:enable='between(t,1.200,1.900)':eof_action=repeat[cmp1]")
    expect(args[args.indexOf('-map') + 1]).toBe('[cmp1]')
  })
})

describe('buildCompositeArgs: backdrops', () => {
  const sizes = new Map([['main', vp], ['tab', vp], ['popup', { width: 640, height: 480 }]])
  const timeline = [
    { pageId: 'main', startMs: 0, endMs: 1000 },
    { pageId: 'tab', startMs: 1000, endMs: 2000 },
    { pageId: 'popup', startMs: 2000, endMs: 2500 },
    { pageId: 'tab', startMs: 2500, endMs: 3000 },
  ]
  const run = (config: Parameters<typeof computePageLayouts>[2], backdrop?: { dim?: number; color?: string }) => {
    const layouts = computePageLayouts('main', pages(sizes), config)
    return graphOf(buildCompositeArgs({
      primaryId: 'main',
      pages: ['main', 'tab', 'popup'].map((id, i) => ({ pageId: id, video: `${id}.webm`, startMs: i * 1000, layout: layouts.get(id)! })),
      timeline, startMs: 0, durationMs: 3000, size: vp, fps: 25, outputPath: 'out.mp4', backdrop,
    }))
  }

  it('puts a popup opened from a tab over that tab, not over the primary page', () => {
    const g = run({})
    expect(g).toContain("[cmp0][pg1]overlay=0:0:enable='between(t,1.000,2.000)+between(t,2.000,2.500)+between(t,2.500,3.000)'")
    expect(g).toContain("[0:v][pg0]overlay=0:0:enable='between(t,0.000,1.000)'")
  })

  it('hides the page behind a replacing popup and scales an overlaid tab', () => {
    const g = run({ popup: 'replace', tab: 'overlay' }, { dim: 0.5, color: '#112233' })
    expect(g).toContain("color=black@0.5:t=fill:enable='between(t,1.000,2.000)+between(t,2.500,3.000)'")
    expect(g).toContain("color=0x112233@1:t=fill:enable='between(t,2.000,2.500)'")
    expect(g).toContain('crop=1280:720:0:0,scale=1088:612')
  })

  it('keeps an overlaid tab on screen under a popup opened over it', () => {
    const g = run({ tab: 'overlay' })
    // The tab through the popup's stretch, drawn after the backdrop and before the popup
    expect(g).toContain("[backdrop][pg1]overlay=96:54:enable='between(t,1.000,2.000)+between(t,2.000,2.500)+between(t,2.500,3.000)':eof_action=repeat[cmp1]")
    expect(g).toContain("[cmp1][pg2]overlay=")
  })

  it('keeps the primary page as the backdrop when only the popup has a stretch', () => {
    const layouts = computePageLayouts('main', pages(new Map([['main', vp], ['popup', { width: 640, height: 480 }]])))
    const args = buildCompositeArgs({
      primaryId: 'main',
      pages: [
        { pageId: 'main', video: 'main.webm', startMs: 1000, layout: layouts.get('main')! },
        { pageId: 'popup', video: 'popup.webm', startMs: 1100, layout: layouts.get('popup')! },
      ],
      timeline: [{ pageId: 'popup', startMs: 1100, endMs: 3000 }],
      startMs: 1100, durationMs: 1900, size: vp, fps: 25, outputPath: 'out.mp4',
    })
    expect(args.filter((a) => a.endsWith('.webm'))).toEqual(['main.webm', 'popup.webm'])
    expect(graphOf(args)).toContain("[0:v][pg0]overlay=0:0:enable='between(t,0.000,1.900)'")
  })
})
