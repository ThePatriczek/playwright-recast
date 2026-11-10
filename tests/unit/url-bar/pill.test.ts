import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { generatePillClip } from '../../../src/url-bar/pill'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recast-o'brien-"))
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('generatePillClip', () => {
  it('draws from a directory with an apostrophe in its name', () => {
    // drawtext sits in a filter graph: its textfile path is unescaped twice
    const { width, height } = generatePillClip({
      text: 'https://example.com/',
      style: { fontSize: 20, color: '#FFFFFF', background: '#1F2328', backgroundOpacity: 0.8 },
      maxWidth: 600,
      durationMs: 300,
      outputPath: path.join(dir, 'urlbar_0.mov'),
    })
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(dir, 'urlbar_0.mov'))).toBe(true)
  })

  it('rounds its corners by `radius`, a stadium by default', () => {
    const alphaNearCorner = (radius: number | undefined, name: string): number => {
      const out = path.join(dir, `${name}.mov`)
      const style = { fontSize: 20, color: '#FFFFFF', background: '#1F2328', backgroundOpacity: 1, ...(radius !== undefined ? { radius } : {}) }
      const { width } = generatePillClip({ text: 'Ctrl + Z', style, maxWidth: 600, durationMs: 100, outputPath: out })
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', `${out}.png`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
      return raw[(3 * width + 3) * 4 + 3]!
    }
    expect(alphaNearCorner(undefined, 'stadium')).toBe(0)
    expect(alphaNearCorner(4, 'keycap')).toBe(255)
  })
})
