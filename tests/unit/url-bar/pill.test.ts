import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
})
