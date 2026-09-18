import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { VisualObservation, VisualObserver, VisualRegion } from '../../types/director.js'
import { runFfmpeg } from '../../utils/ffmpeg.js'

const exec = promisify(execFile)
const SAMPLE_WIDTH = 320
const SAMPLE_HEIGHT = 180

export interface VideoObserverConfig {
  ocr?: boolean
  language?: string
  tesseractPath?: string
}

export function groupTextRegions(regions: VisualRegion[]): VisualRegion[] {
  const groups: VisualRegion[] = []
  for (const region of [...regions].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const existing = groups.find(group => {
      const gap = region.y - (group.y + group.height)
      return gap >= -0.005 && gap < 0.045 && Math.abs(group.x - region.x) < 0.025 && region.y + region.height - group.y < 0.35
    })
    if (!existing) { groups.push({ ...region }); continue }
    const right = Math.max(existing.x + existing.width, region.x + region.width)
    existing.height = region.y + region.height - existing.y
    existing.x = Math.min(existing.x, region.x)
    existing.width = right - existing.x
    existing.text = `${existing.text} ${region.text}`.slice(0, 2000)
    existing.id = `group-${createHash('sha256').update(existing.text).digest('hex').slice(0, 16)}`
  }
  const counts = new Map<string, number>()
  return groups.map(group => {
    const occurrence = counts.get(group.id) ?? 0
    counts.set(group.id, occurrence + 1)
    return { ...group, id: `${group.id}-${occurrence}` }
  })
}

export function parseOcrRegions(tsv: string, width: number, height: number): VisualRegion[] {
  const groups = new Map<string, { words: string[]; left: number; top: number; right: number; bottom: number }>()
  for (const line of tsv.split('\n').slice(1)) {
    const columns = line.split('\t')
    if (columns.length < 12 || columns[0] !== '5' || Number(columns[10]) < 35) continue
    const text = columns.slice(11).join('\t').trim()
    const [left, top, w, h] = columns.slice(6, 10).map(Number)
    if (!text || ![left, top, w, h].every(value => Number.isFinite(value)) || w <= 0 || h <= 0) continue
    const key = columns.slice(1, 5).join('-')
    const existing = groups.get(key)
    if (existing) {
      existing.words.push(text)
      existing.left = Math.min(existing.left, left)
      existing.top = Math.min(existing.top, top)
      existing.right = Math.max(existing.right, left + w)
      existing.bottom = Math.max(existing.bottom, top + h)
    } else groups.set(key, { words: [text], left, top, right: left + w, bottom: top + h })
  }
  const counts = new Map<string, number>()
  return [...groups.values()].slice(0, 80).flatMap(group => {
    const text = group.words.join(' ').slice(0, 500)
    const hash = createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 12)
    const occurrence = counts.get(hash) ?? 0
    counts.set(hash, occurrence + 1)
    const x = Math.max(0, group.left / width)
    const y = Math.max(0, group.top / height)
    const right = Math.min(1, group.right / width)
    const bottom = Math.min(1, group.bottom / height)
    return right > x && bottom > y ? [{ id: `text-${hash}-${occurrence}`, text, x, y, width: right - x, height: bottom - y, kind: 'text' as const, changed: false }] : []
  })
}

export function detectChanges(previous: Buffer, current: Buffer): { fraction: number; regions: VisualRegion[] } {
  if (previous.length !== SAMPLE_WIDTH * SAMPLE_HEIGHT || current.length !== previous.length) throw new Error('Unexpected visual sample dimensions')
  const gridWidth = 16
  const gridHeight = 9
  const counts = new Uint16Array(gridWidth * gridHeight)
  let changed = 0
  for (let y = 0; y < SAMPLE_HEIGHT; y++) {
    for (let x = 0; x < SAMPLE_WIDTH; x++) {
      const index = y * SAMPLE_WIDTH + x
      if (Math.abs(previous[index]! - current[index]!) < 24) continue
      changed++
      counts[Math.floor(y / 20) * gridWidth + Math.floor(x / 20)]!++
    }
  }
  const active = new Set([...counts.entries()].filter(([, count]) => count >= 25).map(([index]) => index))
  const regions: VisualRegion[] = []
  while (active.size) {
    const first = active.values().next().value!
    const queue = [first]
    active.delete(first)
    for (let index = 0; index < queue.length; index++) {
      const cell = queue[index]!
      for (const neighbour of [cell - gridWidth, cell + gridWidth, ...(cell % gridWidth > 0 ? [cell - 1] : []), ...(cell % gridWidth < gridWidth - 1 ? [cell + 1] : [])]) {
        if (active.delete(neighbour)) queue.push(neighbour)
      }
    }
    if (queue.length < 2) continue
    const xs = queue.map(cell => cell % gridWidth)
    const ys = queue.map(cell => Math.floor(cell / gridWidth))
    const x = Math.min(...xs) / gridWidth
    const y = Math.min(...ys) / gridHeight
    regions.push({ id: `change-${first}`, text: 'Visually changed region; meaning unknown', kind: 'change', changed: true, x, y, width: (Math.max(...xs) + 1) / gridWidth - x, height: (Math.max(...ys) + 1) / gridHeight - y })
  }
  return { fraction: changed / current.length, regions: regions.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 6) }
}

export function VideoObserver(config: VideoObserverConfig = {}): VisualObserver {
  return {
    name: config.ocr === false ? 'video-diff' : 'video-diff-tesseract',
    async observe(input) {
      const count = Math.ceil(input.durationMs / input.sampleIntervalMs)
      if (count > input.maxFrames) throw new Error(`Video analysis requires ${count} frames; increase maxFrames or sampleIntervalMs`)
      const binary = config.tesseractPath ?? 'tesseract'
      if (config.ocr !== false) {
        try { await exec(binary, ['--version']) } catch { throw new Error('VideoObserver requires Tesseract OCR. Install tesseract or supply observer: VideoObserver({ ocr: false }) for pixel changes only.') }
      }
      const directory = join(input.workDir, 'observations')
      await mkdir(directory, { recursive: true })
      const selection = `select='gte(t,selected_n*${input.sampleIntervalMs / 1000})'`
      runFfmpeg(['-v', 'error', '-y', '-i', input.videoPath, '-vf', selection, '-fps_mode', 'vfr', '-frames:v', String(count), '-q:v', '2', join(directory, '%06d.jpg')])
      const samples = execFileSync('ffmpeg', ['-v', 'error', '-i', input.videoPath, '-vf', `${selection},scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=gray`, '-fps_mode', 'passthrough', '-frames:v', String(count), '-f', 'rawvideo', 'pipe:1'], { maxBuffer: (count + 1) * SAMPLE_WIDTH * SAMPLE_HEIGHT })
      const frameCount = Math.floor(samples.length / (SAMPLE_WIDTH * SAMPLE_HEIGHT))
      if (!frameCount) throw new Error('Video analysis produced no frames')
      const observations: VisualObservation[] = []
      for (let index = 0; index < frameCount; index++) {
        const imagePath = join(directory, `${String(index + 1).padStart(6, '0')}.jpg`)
        await readFile(imagePath)
        const sample = samples.subarray(index * SAMPLE_WIDTH * SAMPLE_HEIGHT, (index + 1) * SAMPLE_WIDTH * SAMPLE_HEIGHT)
        const previous = observations.at(-1)
        const changes = index ? detectChanges(samples.subarray((index - 1) * SAMPLE_WIDTH * SAMPLE_HEIGHT, index * SAMPLE_WIDTH * SAMPLE_HEIGHT), sample) : { fraction: 0, regions: [] }
        const tsv = config.ocr === false ? '' : (await exec(binary, [imagePath, 'stdout', '-l', config.language ?? 'eng', '--psm', '11', 'tsv'], { maxBuffer: 4 * 1024 * 1024, timeout: 30000 })).stdout
        const regions = groupTextRegions(parseOcrRegions(tsv, input.width, input.height)).map(region => {
          const old = previous?.regions.find(item => item.id === region.id)
          return { ...region, changed: Boolean(previous) && (!old || Math.abs(old.x - region.x) + Math.abs(old.y - region.y) > 0.01) }
        })
        observations.push({ atMs: index * input.sampleIntervalMs, regions: [...regions, ...changes.regions], changeFraction: changes.fraction })
      }
      return observations
    },
  }
}
