import { describe, it, expect } from 'vitest'
import { buildCompositeArgs, PAGE_BACKDROP_DIM } from '../../../src/render/page-compositor'
import { computePageLayouts } from '../../../src/pages/page-timeline'

const vp = { width: 1280, height: 720 }
const pages = (sizes: Map<string, { width: number; height: number }>) => new Map([...sizes].map(([id, size]) => [id, { viewport: size, recorded: size }]))

function graphOf(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1]!
}

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
    expect(graph).toContain("[backdrop][pg1]overlay=320:120:enable='between(t,1.200,1.900)':eof_action=pass[cmp1]")
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
