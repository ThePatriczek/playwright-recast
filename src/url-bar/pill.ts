import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { filterGraphPath, runFfmpeg } from '../utils/ffmpeg.js'

export interface PillStyle {
  /** px, already scaled to the output */
  fontSize: number
  fontFile?: string
  color: string
  background: string
  backgroundOpacity: number
}

const FADE_MS = 150

/** Pills already drawn in one render, by text: a URL often shows more than once. */
export type PillCache = Map<string, { stillPath: string; width: number; height: number }>

const ffColor = (hex: string): string => `0x${hex.replace('#', '')}`

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.substring(i, i + 2), 16)) as [number, number, number]
}

function drawText(textFile: string, style: Pick<PillStyle, 'fontSize' | 'fontFile'>, color: string, x: string, y: string): string {
  // -vf and lavfi inputs are graphs too: paths are unescaped twice
  const font = style.fontFile ? `fontfile=${filterGraphPath(style.fontFile)}:` : ''
  return `drawtext=${font}textfile=${filterGraphPath(textFile)}:expansion=none:fontsize=${style.fontSize}:fontcolor=${ffColor(color)}:x=${x}:y=${y}`
}

/**
 * Fail early when ffmpeg cannot draw text: drawtext needs libfreetype, and a
 * font from fontconfig unless `fontFile` names one.
 */
export function assertCanDrawText(fontFile?: string): void {
  // drawtext falls back to a default font for a missing fontfile, silently
  if (fontFile && !fs.existsSync(fontFile)) throw new Error(`urlBar({ fontFile }): no such file: ${fontFile}`)
  const res = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x32:d=0.04',
    '-vf', `drawtext=${fontFile ? `fontfile=${filterGraphPath(fontFile)}:` : ''}text=x`, '-frames:v', '1', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(
      'urlBar() needs ffmpeg with the drawtext filter (libfreetype) and a font: ' +
      `install fontconfig fonts or pass urlBar({ fontFile }). ffmpeg said: ${(res.stderr ?? '').trim().split('\n').pop()}`,
    )
  }
}

/** Rendered width of the text in px, measured by drawing it once. */
export function measureTextWidth(textFile: string, style: Pick<PillStyle, 'fontSize' | 'fontFile'>): number {
  const { fontSize } = style
  const canvas = `color=black:s=${Math.max(64, fontSize * 400)}x${fontSize * 3}:d=0.04`
  const res = spawnSync('ffmpeg', [
    '-hide_banner', '-f', 'lavfi', '-i', canvas,
    '-vf', `${drawText(textFile, style, '#FFFFFF', '0', String(fontSize))},bbox`,
    '-frames:v', '1', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const m = /x1:(\d+) x2:(\d+)/.exec(res.stderr ?? '')
  return m ? Number(m[2]) + 1 : Math.round(fontSize * 0.6 * fs.readFileSync(textFile, 'utf8').length)
}

/** Shorten from the middle, keeping the host at the start and the end of the path. */
function ellipsize(text: string, chars: number): string {
  if (text.length <= chars) return text
  const head = Math.ceil((chars - 3) * 0.6)
  return `${text.slice(0, head)}...${text.slice(text.length - (chars - 3 - head))}`
}

/** The pill as one RGBA still: text centered in a stadium, shortened to fit `maxWidth`. */
function drawPill(fullText: string, style: PillStyle, maxWidth: number, stillPath: string): { stillPath: string; width: number; height: number } {
  const padX = Math.round(style.fontSize * 0.9)
  const height = 2 * Math.round(style.fontSize * 0.9)
  const textFile = `${stillPath}.txt`

  let text = fullText
  let textWidth = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    fs.writeFileSync(textFile, text)
    textWidth = measureTextWidth(textFile, style)
    if (textWidth + 2 * padX <= maxWidth || text.length <= 8) break
    text = ellipsize(text, Math.floor(text.length * (maxWidth - 2 * padX) / textWidth) - 1)
  }
  const width = 2 * Math.ceil(Math.min(maxWidth, textWidth + 2 * padX) / 2)

  const [r, g, b] = hexToRgb(style.background)
  const alpha = Math.round(style.backgroundOpacity * 255)
  const radius = height / 2
  const e = '\\,' // escaped comma inside geq expressions
  // Stadium: a rectangle with half circles at both ends.
  const inside = `if(lt(X${e}${radius})${e}lte(hypot(X-${radius}${e}Y-${radius})${e}${radius})${e}` +
    `if(gt(X${e}${width - radius})${e}lte(hypot(X-${width - radius}${e}Y-${radius})${e}${radius})${e}1))`
  runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=black@0:s=${width}x${height}:d=0.04,format=rgba`,
    '-vf', [
      `geq=r=${r}:g=${g}:b=${b}:a=${alpha}*${inside}`,
      drawText(textFile, style, style.color, '(w-text_w)/2', '(h-ascent+descent)/2'),
    ].join(','),
    '-frames:v', '1', stillPath,
  ])
  return { stillPath, width, height }
}

/**
 * A transparent clip of a rounded pill with the text centered in it, fading
 * in and out. Longer text than `maxWidth` allows is shortened in the middle.
 */
export function generatePillClip(opts: {
  text: string
  style: PillStyle
  maxWidth: number
  durationMs: number
  outputPath: string
  /** One per render, so a still is never reused from a run that drew others at its path */
  cache?: PillCache
}): { width: number; height: number } {
  const { style } = opts
  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
  const key = JSON.stringify([opts.text, style, opts.maxWidth])
  const still = opts.cache?.get(key) ?? drawPill(opts.text, style, opts.maxWidth, `${opts.outputPath}.png`)
  opts.cache?.set(key, still)
  const { stillPath, width, height } = still
  const durSec = Math.max(0.04, opts.durationMs / 1000)
  const fadeSec = Math.min(FADE_MS / 1000, durSec / 3)

  runFfmpeg([
    '-y', '-loop', '1', '-framerate', '30', '-i', stillPath, '-t', durSec.toFixed(3),
    '-vf', [
      'format=rgba',
      `fade=t=in:st=0:d=${fadeSec.toFixed(3)}:alpha=1`,
      `fade=t=out:st=${(durSec - fadeSec).toFixed(3)}:d=${fadeSec.toFixed(3)}:alpha=1`,
    ].join(','),
    '-c:v', 'qtrle', '-pix_fmt', 'argb', opts.outputPath,
  ])
  return { width, height }
}
