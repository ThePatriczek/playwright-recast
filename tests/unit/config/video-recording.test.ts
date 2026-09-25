import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import { recastVideo } from '../../../src/config/video'

// Each of the three settings fails silently on its own, so only a real
// recording shows they agree. Skipped where Chromium is not installed.
const VIEWPORT = { width: 320, height: 240 }
let tmpDir: string

async function launch(scale: number): Promise<Browser | undefined> {
  const use = recastVideo({ viewport: VIEWPORT, scale })
  try {
    return await chromium.launch({ headless: use.headless, args: use.launchOptions.args })
  } catch {
    return undefined
  }
}

const available = await launch(1).then(async (b) => { await b?.close(); return b !== undefined })

/** Record a full-bleed red page with recastVideo()'s options. */
async function record(scale: number): Promise<string> {
  const use = recastVideo({ viewport: VIEWPORT, scale })
  const browser = (await launch(scale))!
  const context = await browser.newContext({
    viewport: use.viewport,
    deviceScaleFactor: use.deviceScaleFactor,
    recordVideo: { dir: tmpDir, size: use.video.size },
  })
  const page = await context.newPage()
  await page.setContent('<body style="margin:0;background:#f00"></body>')
  await page.waitForTimeout(500)
  const video = page.video()!
  await context.close()
  await browser.close()
  return video.path()
}

function size(file: string): { width: number; height: number } {
  const [width, height] = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ]).toString().trim().split(',').map(Number)
  return { width: width!, height: height! }
}

/** RGB of the bottom-right pixel (2x2 crop: 4:2:0 needs even sizes): page content, or gray padding. */
function bottomRight(file: string): number[] {
  const rgb = execFileSync('ffmpeg', [
    '-v', 'error', '-ss', '0.3', '-i', file, '-frames:v', '1',
    '-vf', 'crop=2:2:iw-2:ih-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
  return [...rgb.subarray(9, 12)]
}

describe.skipIf(!available)('recastVideo() recording', () => {
  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-video-')) })
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  it.each([2, 1.5])('records the page at viewport x %s, unpadded', async (scale) => {
    const file = await record(scale)
    expect(size(file)).toEqual({ width: VIEWPORT.width * scale, height: VIEWPORT.height * scale })
    const [r, g, b] = bottomRight(file)
    expect(r).toBeGreaterThan(200)
    expect(g).toBeLessThan(60)
    expect(b).toBeLessThan(60)
  })
}, 60_000)
