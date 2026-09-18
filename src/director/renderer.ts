import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import type { DirectorDecision, DirectorOptions, DirectorProvider, DirectorReport, VisualObservation } from '../types/director.js'
import type { RenderConfig } from '../types/render.js'
import type { SubtitleEntry } from '../types/subtitle.js'
import { runFfmpeg } from '../utils/ffmpeg.js'
import { parseSrt } from '../subtitles/srt-parser.js'
import { writeSrt } from '../subtitles/srt-writer.js'
import { writeAss } from '../subtitles/ass-writer.js'
import { buildCameraFilter } from './camera.js'
import { buildEffectGraph } from './actions.js'
import { VideoObserver } from './observers/video.js'
import { planDirection, validateDirectorOptions } from './planner.js'

const regionSchema = z.object({
  id: z.string().min(1), text: z.string().max(2000), kind: z.enum(['text', 'change']), changed: z.boolean(),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine(region => region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001, 'Region leaves the frame')

export function validateObservations(input: unknown, durationMs: number, maxFrames: number): VisualObservation[] {
  const observations = z.array(z.object({ atMs: z.number().nonnegative(), changeFraction: z.number().min(0).max(1), regions: z.array(regionSchema).max(100) })).min(1).max(maxFrames).parse(input)
  if (observations[0]!.atMs !== 0) throw new Error('Visual observations must start at zero')
  for (const [index, observation] of observations.entries()) {
    if (observation.atMs >= durationMs || (index && observation.atMs <= observations[index - 1]!.atMs)) throw new Error('Observation times must strictly increase within the video')
    if (new Set(observation.regions.map(region => region.id)).size !== observation.regions.length) throw new Error('Visual region ids must be unique within a frame')
  }
  return observations
}

export function remapDirectorSubtitles(subtitles: SubtitleEntry[], decisions: DirectorDecision[]): SubtitleEntry[] {
  const remap = (time: number, end: boolean) => {
    const decision = decisions.find(item => time < item.sourceEndMs || (end && time === item.sourceEndMs)) ?? decisions.at(-1)
    if (!decision) return time
    const mapped = decision.outputStartMs + Math.max(0, Math.min(time, decision.sourceEndMs) - decision.sourceStartMs) / decision.speed
    return Math.round(mapped + (end && time >= decision.sourceEndMs ? decision.holdMs : 0))
  }
  return subtitles.map(subtitle => ({ ...subtitle, startMs: remap(subtitle.startMs, false), endMs: remap(subtitle.endMs, true) })).filter(subtitle => subtitle.endMs > subtitle.startMs)
}

function retimeVideo(source: string, decisions: DirectorDecision[], workDir: string, fps: number, hasAudio: boolean): string {
  if (decisions.every(decision => decision.speed === 1 && decision.holdMs === 0)) return source
  const clips: string[] = []
  for (const [index, decision] of decisions.entries()) {
    const name = `tempo-${index}.mov`
    const sourceDuration = (decision.sourceEndMs - decision.sourceStartMs) / 1000
    const frames = Math.round(decision.outputEndMs / 1000 * fps) - Math.round(decision.outputStartMs / 1000 * fps)
    if (frames <= 0) continue
    const outputDuration = frames / fps
    const args = ['-v', 'error', '-y', '-ss', String(decision.sourceStartMs / 1000), '-t', String(sourceDuration), '-i', source, '-map', '0:v:0', '-vf', `setpts=(PTS-STARTPTS)/${decision.speed},fps=${fps},tpad=stop_mode=clone:stop_duration=${decision.holdMs / 1000}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18']
    if (hasAudio) {
      const speed = decision.speed === 3 ? 'atempo=1.5,atempo=2' : `atempo=${decision.speed}`
      args.push('-map', '0:a:0', '-af', `asetpts=PTS-STARTPTS,${speed},apad,atrim=duration=${outputDuration}`, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2')
    }
    args.push('-frames:v', String(frames), '-t', String(outputDuration), path.join(workDir, name))
    runFfmpeg(args)
    clips.push(`file '${name}'`)
  }
  const manifest = path.join(workDir, 'tempo.txt')
  fs.writeFileSync(manifest, clips.join('\n'))
  const output = path.join(workDir, 'retimed.mov')
  runFfmpeg(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-c', 'copy', output])
  return output
}

export async function directVideo(source: string, output: string, provider: DirectorProvider, options: DirectorOptions, render: RenderConfig, workDir: string, hasVoiceover = false): Promise<DirectorReport> {
  validateDirectorOptions(options)
  fs.mkdirSync(workDir, { recursive: true })
  const probe = z.object({ format: z.object({ duration: z.coerce.number().positive() }), streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional() })) }).parse(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', source]).toString()))
  const video = probe.streams.find(stream => stream.codec_type === 'video')
  if (!video?.width || !video.height) throw new Error('Director source has no video dimensions')
  const durationMs = probe.format.duration * 1000
  const fps = render.fps ?? 30
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error('Director fps must be between zero and 120')
  const observer = options.observer ?? VideoObserver()
  const observations = validateObservations(await observer.observe({ videoPath: source, workDir, width: video.width, height: video.height, durationMs, sampleIntervalMs: options.sampleIntervalMs ?? 500, maxFrames: options.maxFrames ?? 900 }), durationMs, options.maxFrames ?? 900)
  console.log(`  Director: ${observations.length} visual observations from ${observer.name}`)
  const timingLocked = hasVoiceover || options.timing === 'preserve'
  const plan = await planDirection(provider, options, observations, durationMs, timingLocked)
  let subtitles: SubtitleEntry[] = []
  if (probe.streams.some(stream => stream.codec_type === 'subtitle')) {
    const subtitlePath = path.join(workDir, 'source.srt')
    runFfmpeg(['-v', 'error', '-y', '-i', source, '-map', '0:s:0', subtitlePath])
    subtitles = remapDirectorSubtitles(parseSrt(fs.readFileSync(subtitlePath, 'utf8')), plan.decisions)
  }
  const report: DirectorReport = { version: 1, provider: provider.name, observer: observer.name, goal: options.goal, sourceDurationMs: durationMs, outputDurationMs: plan.outputDurationMs, timingLocked, observations, requests: plan.requests, decisions: plan.decisions, keyframes: plan.keyframes, subtitles }
  const reportPath = options.reportPath ?? output.replace(/\.[^/.]+$/, '') + '.director.json'
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  const timedVideo = retimeVideo(source, plan.decisions, workDir, fps, probe.streams.some(stream => stream.codec_type === 'audio'))
  const effects = buildEffectGraph(plan.effects, video.width, video.height)
  const filters = [effects.graph, `[${effects.output}]${buildCameraFilter(plan.keyframes, video.width, video.height, fps)}[camera]`].filter(Boolean)
  let videoOutput = 'camera'
  if (render.burnSubtitles && subtitles.length) {
    const assPath = path.join(workDir, 'directed.ass')
    fs.writeFileSync(assPath, writeAss(subtitles, render.subtitleStyle, { width: video.width, height: video.height }))
    const escaped = assPath.replace(/'/g, "'\\''").replace(/:/g, '\\:')
    filters.push(`[camera]ass='${escaped}'[captioned]`)
    videoOutput = 'captioned'
  }
  const format = render.format ?? 'mp4'
  const encoded = path.join(workDir, `directed.${format}`)
  const args = ['-v', 'error', '-y', '-i', timedVideo]
  const embedded = Boolean(render.embedSubtitles && subtitles.length)
  if (embedded) {
    const subtitlePath = path.join(workDir, 'directed.srt')
    fs.writeFileSync(subtitlePath, writeSrt(subtitles))
    args.push('-i', subtitlePath)
  }
  args.push('-filter_complex', filters.join(';'), '-map', `[${videoOutput}]`, '-map', '0:a?', '-c:v', render.codec ?? (format === 'webm' ? 'libvpx-vp9' : 'libx264'), '-crf', String(render.crf ?? 23))
  if (format === 'mp4') args.push('-preset', 'fast', '-c:a', timedVideo === source ? 'copy' : 'aac', '-movflags', '+faststart')
  else args.push('-b:v', '0', '-c:a', 'libopus')
  if (embedded) {
    const settings = typeof render.embedSubtitles === 'object' ? render.embedSubtitles : {}
    args.push('-map', '1:0', '-c:s', format === 'webm' ? 'webvtt' : 'mov_text', '-metadata:s:s:0', `language=${settings.language ?? 'eng'}`, '-metadata:s:s:0', `title=${settings.title ?? 'Subtitles'}`, '-disposition:s:0', settings.default ? 'default' : '0')
  }
  args.push('-t', String(plan.outputDurationMs / 1000), encoded)
  runFfmpeg(args)
  fs.copyFileSync(encoded, output)
  return report
}
