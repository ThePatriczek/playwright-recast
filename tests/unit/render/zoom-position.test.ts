import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { buildZoomFilter } from '../../../src/render/zoom-expression'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-zoom-position-'))

/** Center of the red pixels in a binary PPM (P6), as fractions of width/height. */
function redCenter(ppm: Buffer): { x: number; y: number } {
  const header = ppm.toString('latin1', 0, 64).split(/\s+/)
  const width = Number(header[1]), height = Number(header[2])
  const dataStart = ppm.length - width * height * 3
  let sx = 0, sy = 0, n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = dataStart + (y * width + x) * 3
      if (ppm[i]! > 200 && ppm[i + 1]! < 80 && ppm[i + 2]! < 80) { sx += x; sy += y; n++ }
    }
  }
  return { x: sx / n / width, y: sy / n / height }
}

describe('buildZoomFilter crop position', () => {
  afterAll(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }))

  // A source larger than the output (e.g. a DPR 2 recording rendered at
  // 1440p) is where a crop computed in the wrong coordinate space shows.
  it('centers the zoom target when source and output sizes differ', () => {
    const out = path.join(TMP_DIR, 'frame.ppm')
    const target = { x: 0.37, y: 0.5 }
    const filter = buildZoomFilter(
      [{ atMs: 0, transitionMs: 3000, x: target.x, y: target.y, level: 1.8 }],
      { width: 3840, height: 2160 },
      { width: 2560, height: 1440 },
      { transitionMs: 0, easing: 'linear', fps: 25, containInCue: false },
    )
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi',
      '-i', `color=white:s=3840x2160:d=2:r=25,drawbox=x=${3840 * target.x - 20}:y=${2160 * target.y - 20}:w=40:h=40:color=red:t=fill`,
      '-vf', filter, '-ss', '1', '-frames:v', '1', out,
    ], { stdio: 'pipe' })

    const center = redCenter(fs.readFileSync(out))
    expect(center.x).toBeCloseTo(0.5, 2)
    expect(center.y).toBeCloseTo(0.5, 2)
  })
})
