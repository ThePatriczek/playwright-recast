import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rendererPath = path.resolve(__dirname, '../../../src/render/renderer.ts')

/**
 * Regression guard for GitHub issue #4.
 *
 * ffmpeg 8.x changed the overlay filter's `format` default-resolution
 * heuristic: with an RGBA secondary input it now selects `yuva444p`,
 * which produces a green-tinted result once the pipeline encodes to
 * yuv420p. Every overlay filter that mixes an RGBA cursor/ripple/highlight
 * onto a yuv420 video must therefore pin `format=yuv420` explicitly.
 */
describe('overlay filter format (ffmpeg 8.x compat)', () => {
  const source = fs.readFileSync(rendererPath, 'utf8')

  it('contains no overlay filter with format=auto', () => {
    const offenders = source
      .split('\n')
      .map((line, idx) => ({ line, idx: idx + 1 }))
      .filter(({ line }) => /overlay=[^'`"]*format=auto/.test(line))

    expect(offenders, `overlay=...format=auto offenders:\n${offenders.map(o => `${o.idx}: ${o.line.trim()}`).join('\n')}`).toHaveLength(0)
  })

  it('every overlay= filter pins format=yuv420', () => {
    const overlayLines = source
      .split('\n')
      .map((line, idx) => ({ line, idx: idx + 1 }))
      .filter(({ line }) => /(?<!\w)overlay=/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*'))

    expect(overlayLines.length).toBeGreaterThan(0)
    for (const { line, idx } of overlayLines) {
      expect(line, `line ${idx} must pin format=yuv420: ${line.trim()}`).toMatch(/format=yuv420/)
    }
  })
})
