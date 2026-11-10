import * as fs from 'node:fs'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import type { MouseIndicatorInput, WheelDirection } from '../types/input-overlay.js'

/** What one icon image shows. */
export type MouseIconState = Exclude<MouseIndicatorInput, 'wheel'> | `wheel-${WheelDirection}`

export interface MouseIconStyle {
  /** Height in px */
  height: number
  color: string
  outlineColor: string
  accentColor: string
}

type Rgba = [number, number, number, number]

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.substring(i, i + 2), 16)) as [number, number, number]
}

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const k = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len))
  return Math.hypot(px - (ax + k * dx), py - (ay + k * dy))
}

/** The chevron's two strokes for a wheel direction, around (cx, cy). */
function chevron(dir: WheelDirection, cx: number, cy: number, a: number): Array<[number, number, number, number]> {
  const tip: Record<WheelDirection, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
  const [ux, uy] = tip[dir]
  // Tip half a size ahead of the center, both wings half a size behind it.
  const tx = cx + ux * a * 0.5
  const ty = cy + uy * a * 0.5
  const bx = cx - ux * a * 0.5
  const by = cy - uy * a * 0.5
  return [[bx - uy * a, by - ux * a, tx, ty], [bx + uy * a, by + ux * a, tx, ty]]
}

/**
 * An RGBA mouse icon: a rounded body split into two buttons with a wheel
 * between them. The pressed button or the wheel is in the accent color; a
 * wheel turn adds a chevron for its direction in the lower body.
 */
export function renderMouseIcon(state: MouseIconState, style: MouseIconStyle): { width: number; height: number; rgba: Buffer } {
  const height = Math.max(12, Math.round(style.height))
  const width = Math.round(height * 0.66)
  const r = (width - 2) / 2
  const cx = width / 2
  const top = 1 + r
  const bottom = height - 1 - r
  const stroke = Math.max(1.5, height * 0.06)
  const buttonsEnd = height * 0.42
  const wheel = { top: height * 0.14, bottom: height * 0.32, half: Math.max(1, width * 0.09) }
  const direction = state.startsWith('wheel-') ? (state.slice(6) as WheelDirection) : undefined
  const strokes = direction ? chevron(direction, cx, height * 0.68, width * 0.2) : []

  const body: Rgba = [...rgb(style.color), 255]
  const line: Rgba = [...rgb(style.outlineColor), 255]
  const accent: Rgba = [...rgb(style.accentColor), 255]

  const colorAt = (x: number, y: number): Rgba | null => {
    const d = segmentDistance(x, y, cx, top, cx, bottom)
    if (d > r) return null
    if (d > r - stroke) return line
    if (y >= wheel.top && y <= wheel.bottom && segmentDistance(x, y, cx, wheel.top + wheel.half, cx, wheel.bottom - wheel.half) <= wheel.half) {
      return state === 'middle' || direction ? accent : line
    }
    if (y < buttonsEnd && Math.abs(x - cx) <= stroke * 0.4) return line
    if (Math.abs(y - buttonsEnd) <= stroke * 0.3) return line
    if (y < buttonsEnd && ((state === 'left' && x < cx) || (state === 'right' && x > cx))) return accent
    if (strokes.some(([ax, ay, bx, by]) => segmentDistance(x, y, ax, ay, bx, by) <= stroke * 0.6)) return accent
    return body
  }

  // 4x4 supersampling for smooth edges.
  const N = 4
  const rgba = Buffer.alloc(width * height * 4)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const sum = [0, 0, 0, 0]
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = colorAt(px + (sx + 0.5) / N, py + (sy + 0.5) / N)
          if (!c) continue
          for (let k = 0; k < 3; k++) sum[k]! += c[k]!
          sum[3]! += 1
        }
      }
      const o = (py * width + px) * 4
      if (sum[3]! === 0) continue
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(sum[k]! / sum[3]!)
      rgba[o + 3] = Math.round((255 * sum[3]!) / (N * N))
    }
  }
  return { width, height, rgba }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** An 8-bit RGBA PNG. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Write the icon for `state` as a PNG in `dir`; returns its path. */
export function writeMouseIcon(state: MouseIconState, style: MouseIconStyle, dir: string): string {
  const { width, height, rgba } = renderMouseIcon(state, style)
  const file = path.join(dir, `mouse-${state}.png`)
  fs.writeFileSync(file, encodePng(width, height, rgba))
  return file
}
