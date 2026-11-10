import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { renderMouseIcon, writeMouseIcon, type MouseIconState } from '../../../src/input-overlay/mouse-icon'

const style = { height: 50, color: '#FFFFFF', outlineColor: '#000000', accentColor: '#0000FF' }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-mouse-icon-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const pixel = (state: MouseIconState, fx: number, fy: number): number[] => {
  const { width, height, rgba } = renderMouseIcon(state, style)
  const o = (Math.floor(fy * height) * width + Math.floor(fx * width)) * 4
  return [...rgba.subarray(o, o + 4)]
}
const BLUE = [0, 0, 255, 255]
const WHITE = [255, 255, 255, 255]

describe('renderMouseIcon()', () => {
  it('fills the pressed button only', () => {
    expect(pixel('left', 0.3, 0.3)).toEqual(BLUE)
    expect(pixel('left', 0.7, 0.3)).toEqual(WHITE)
    expect(pixel('right', 0.7, 0.3)).toEqual(BLUE)
    expect(pixel('right', 0.3, 0.3)).toEqual(WHITE)
  })

  it('fills the wheel for the middle button and wheel turns', () => {
    expect(pixel('middle', 0.5, 0.23)).toEqual(BLUE)
    expect(pixel('left', 0.5, 0.23)).toEqual([0, 0, 0, 255])
    expect(pixel('wheel-up', 0.5, 0.23)).toEqual(BLUE)
  })

  it('points a chevron the way the wheel turns', () => {
    // The tip sits ahead of the center: up above it, down below it.
    expect(pixel('wheel-up', 0.5, 0.68 - 0.066 * 0.5)).toEqual(BLUE)
    expect(pixel('wheel-up', 0.5, 0.68 + 0.066 * 0.5)).toEqual(WHITE)
    expect(pixel('wheel-down', 0.5, 0.68 + 0.066 * 0.5)).toEqual(BLUE)
  })

  it('is transparent outside the body', () => {
    expect(pixel('left', 0.02, 0.02)[3]).toBe(0)
  })
})

describe('writeMouseIcon()', () => {
  it('writes a PNG ffmpeg decodes to the same pixels', () => {
    const file = writeMouseIcon('right', style, dir)
    const { width, height, rgba } = renderMouseIcon('right', style)
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    expect(decoded.length).toBe(width * height * 4)
    expect(decoded.equals(rgba)).toBe(true)
  })
})
