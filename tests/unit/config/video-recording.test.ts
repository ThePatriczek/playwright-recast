import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { chromium } from 'playwright-core'
import { recastVideo } from '../../../src/config/video'

// Each of the three settings fails silently on its own, so only a real
// recording shows they agree. Skipped where Chromium is not installed; a
// launch failure with these options fails the test.
const VIEWPORT = { width: 320, height: 240 }
const available = fs.existsSync(chromium.executablePath())
let tmpDir: string

/** Record a black page with a red marker in its bottom-right corner. */
async function record(scale: number): Promise<string> {
  const use = recastVideo({ viewport: VIEWPORT, scale })
  const browser = await chromium.launch({ headless: use.headless, args: use.launchOptions.args })
  const context = await browser.newContext({
    viewport: use.viewport,
    deviceScaleFactor: use.deviceScaleFactor,
    recordVideo: { dir: tmpDir, size: use.video.size },
  })
  const page = await context.newPage()
  // Include a blank lead to catch assertions that sample before the page paints.
  await page.waitForTimeout(500)
  await page.setContent('<body style="margin:0;background:#000"><div style="position:fixed;right:0;bottom:0;width:8px;height:8px;background:#f00"></div></body>')
  // A frame painted with the content, or under load the screencast can close on the blank page
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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

/** RGB of the final frame's bottom-right pixel (2x2 crop: 4:2:0 needs even sizes): red marker when exact, gray when padded, black when cropped. */
function bottomRight(file: string): number[] {
  const rgb = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file,
    '-vf', 'crop=2:2:iw-2:ih-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
  // Startup can take longer than 0.3s on CI. The final frame is after the
  // paint wait; an absolute timestamp may still point at the blank page.
  return [...rgb.subarray(-3)]
}

describe.skipIf(!available)('recastVideo() recording', () => {
  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-video-')) })
  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  // 1.33 gives 425.6 x 319.2 and records at 1.35.
  it.each([2, 1.5, 1.33])('records the page at viewport x %s, unpadded and uncropped', async (scale) => {
    const file = await record(scale)
    expect(size(file)).toEqual(recastVideo({ viewport: VIEWPORT, scale }).video.size)
    const [r, g, b] = bottomRight(file)
    expect(r).toBeGreaterThan(200)
    expect(g).toBeLessThan(60)
    expect(b).toBeLessThan(60)
  })
}, 60_000)
