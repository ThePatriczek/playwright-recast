import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { z } from 'zod'
import { Pipeline } from '../../dist/pipeline/pipeline.js'
import { parseSrt } from '../../dist/subtitles/srt-parser.js'
import { queryJev, type ChoiceQuestion } from './model.ts'
import { buildCameraFilter, cropFor, focusInShot, overview, type CameraKeyframe, type CameraPose, type FocusRegion } from './camera-rig.ts'
import { actionCandidates, buildEffectGraph, stabilizeAction, type CameraAction, type CameraEffect } from './camera-actions.ts'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
process.chdir(root)
if (existsSync('.env')) process.loadEnvFile('.env')
const { values } = parseArgs({ options: { run: { type: 'string' }, mock: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } })

const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
const controlSchema = z.object({ label: z.string(), box: boxSchema })
const browserSchema = z.object({ text: z.string(), controls: z.array(controlSchema) })
const observationSchema = z.object({ event: z.literal('observation'), step: z.number(), state: z.object({ browser: browserSchema }) })
const executionSchema = z.object({ event: z.literal('executed'), step: z.number(), action: z.object({ kind: z.string(), description: z.string(), target: controlSchema.optional() }), after: browserSchema })
type CameraDecision = {
  atMs: number
  endMs: number
  scene: string
  command: string
  requestedCommand: string
  reason: string
  from: CameraPose
  to: CameraPose
  focus: FocusRegion
  targets: FocusRegion[]
  confidence: number | null
  probabilities: Record<string, number>
  elapsedMs: number
  frame: string
}

async function latestRun(): Promise<string> {
  const directory = join(root, 'test-results/jev')
  for (const name of (await readdir(directory)).sort().reverse()) {
    const candidate = join(directory, name)
    if (!existsSync(join(candidate, 'run.json'))) continue
    const run = JSON.parse(await readFile(join(candidate, 'run.json'), 'utf8'))
    if (run.success) return candidate
  }
  throw new Error('No successful browser run found. Run npm run poc:jev first.')
}

async function main(): Promise<void> {
  if (values.help) { console.log('npm run poc:camera -- [--run path/to/successful/run] [--mock]'); return }
  const sourceRun = values.run ? resolve(values.run) : await latestRun()
  const run = z.object({ success: z.literal(true), recordingDirectory: z.string() }).parse(JSON.parse(await readFile(join(sourceRun, 'run.json'), 'utf8')))
  const output = join(sourceRun, `camera-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(join(output, 'frames'), { recursive: true })
  console.log(`Camera artifacts: ${output}`)
  const events: unknown[] = (await readFile(join(sourceRun, 'decisions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const observations = events.flatMap(event => { const parsed = observationSchema.safeParse(event); return parsed.success ? [parsed.data] : [] })
  const executions = events.flatMap(event => { const parsed = executionSchema.safeParse(event); return parsed.success ? [parsed.data] : [] })
  if (!executions.length) throw new Error('No recorded actions to direct')
  const baseVideo = join(output, 'source.mp4')
  await Pipeline.from(run.recordingDirectory)
    .parse()
    .hideSteps(action => action.title === 'Jev decision')
    .speedUp({ duringIdle: 1, duringUserAction: 1, duringNetworkWait: 2, duringNavigation: 2, exactBoundaries: true })
    .subtitlesFromTrace()
    .enrichZoomFromReport(Array.from({ length: executions.length + 2 }, () => ({ zoom: { x: 0.5, y: 0.5, level: 1 } })))
    .cursorOverlay({ approachMs: 0, moveDurationMs: 350, hideAfterMs: 800 })
    .clickEffect({ color: '#818cf8', sound: true, soundVolume: 0.2 })
    .textHighlight()
    .render({ resolution: '720p', fps: 30, embedSubtitles: true })
    .toFile(baseVideo)
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', baseVideo, '-map', '0:s:0', join(output, 'aligned.srt')])
  const cues = parseSrt(await readFile(join(output, 'aligned.srt'), 'utf8'))
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height', '-of', 'json', baseVideo])).stdout)
  const durationMs = Math.round(Number(probe.format.duration) * 1000)
  const video = z.object({ width: z.number(), height: z.number() }).parse(probe.streams.find((stream: { width?: number }) => stream.width))
  const keyframes: CameraKeyframe[] = [{ ...overview, atMs: 0 }]
  const decisions: CameraDecision[] = []
  const effects: CameraEffect[] = []
  let pose: CameraPose = { ...overview }
  let actionIndex = 0
  let lastMoveEndMs = -10_000
  let lastEffectEndMs = -10_000
  const normalizedFocus = (target: z.infer<typeof controlSchema>): FocusRegion => ({
    x: target.box.x / video.width,
    y: target.box.y / video.height,
    width: target.box.width / video.width,
    height: target.box.height / video.height,
    label: target.label,
  })
  const appendPoint = (atMs: number, next: CameraPose) => {
    if (atMs > keyframes[keyframes.length - 1].atMs) keyframes.push({ ...next, atMs })
  }
  for (const cue of cues) {
    const execution = executions[actionIndex]
    if (!execution || cue.text !== execution.action.description) continue
    actionIndex++
    const observation = observations.find(item => item.step === execution.step)
    if (!observation) throw new Error(`Missing browser observation for step ${execution.step}`)
    const target = execution.action.target
    const focus = target ? normalizedFocus(target) : { x: 0.25, y: 0.2, width: 0.5, height: 0.6, label: 'Page overview' }
    const currentControls = observation.state.browser.controls
    const previousControls = observations.find(item => item.step === execution.step - 1)?.state.browser.controls
    const resultControl = previousControls && currentControls.find(control => !previousControls.some(previous => previous.label === control.label))
    const related = currentControls.filter(control => control.label !== target?.label).map(normalizedFocus).sort((a, b) => Math.hypot(a.x - focus.x, a.y - focus.y) - Math.hypot(b.x - focus.x, b.y - focus.y)).slice(0, 1)
    const context = { focus, related: [focus, ...related], result: resultControl ? normalizedFocus(resultControl) : undefined }
    const ticks = Math.max(1, Math.floor((cue.endMs - cue.startMs) / 1100))
    for (let tick = 0; tick < ticks; tick++) {
      const atMs = Math.round(cue.startMs + tick * (cue.endMs - cue.startMs) / ticks)
      const endMs = Math.round(cue.startMs + (tick + 1) * (cue.endMs - cue.startMs) / ticks)
      const commands = actionCandidates(pose, context, atMs, endMs)
      const frame = `frames/${String(decisions.length).padStart(3, '0')}.jpg`
      await exec('ffmpeg', ['-v', 'error', '-y', '-ss', String(atMs / 1000), '-i', baseVideo, '-frames:v', '1', '-q:v', '3', join(output, frame)])
      const state = {
        brief: 'Make a calm, readable product walkthrough. STAY is the default. Move only to fix a clipped or off-center subject, or make a small important control readable. A new browser action does not require a new camera move. Keep a good composition across several actions.',
        scene: { action: cue.text, phase: tick === 0 ? 'start of action' : 'action in progress or result', progress: tick / ticks, sourceBefore: observation.state.browser, sourceAfter: execution.after },
        camera: { ...pose, crop: cropFor(pose), millisecondsSinceLastMove: atMs - lastMoveEndMs, minimumHoldMs: 2200 },
        focus: { ...focus, inCurrentShot: focusInShot(pose, focus) },
        subjects: context,
        composition: { detailUseful: ['fill', 'toggle'].includes(execution.action.kind), preferredDetailZoom: 1.35, resultAvailable: Boolean(context.result), trackingAvailable: false, millisecondsSinceLastEffect: atMs - lastEffectEndMs },
        recentCommands: decisions.slice(-4).map(decision => ({ scene: decision.scene, command: decision.command, to: decision.to })),
        candidates: Object.fromEntries(Object.entries(commands).map(([command, plan]) => [command, { pose: plan.keyframes.at(-1), targets: plan.targets, effects: plan.effects, purpose: plan.reason }])),
        timing: { atMs, endMs, durationMs },
      }
      const questions: Record<string, ChoiceQuestion> = {
        camera: {
          type: 'choice',
          instructions: 'Establish a useful shot, then choose stay to let the viewer read. When composition.detailUseful is true and camera.zoom is below 1.25, choose focus to introduce the detail at preferredDetailZoom; once composed, stay. focus frames one important control; fit shows related controls together; follow tracks observed moving positions only; reveal shows an observed new result; overview restores page context; spotlight dims surroundings without moving; pulse briefly emphasizes a change without moving. Prefer reveal for a new result outside the shot, and overview when finishing. Choose an effect only when the existing shot is good and emphasis helps. Never invent target positions. Do not repeatedly decorate every click. Respect movement and effect cooldowns. These choices change the recording, never the browser.',
          criteria: Object.fromEntries(Object.entries(commands).map(([command, plan]) => [command, `${command}: ${plan.reason}; targets ${JSON.stringify(plan.targets)}; final pose ${JSON.stringify(plan.keyframes.at(-1))}`])),
        },
      }
      await appendFile(join(output, 'camera-decisions.jsonl'), `${JSON.stringify({ event: 'state', state, questions, frame })}\n`)
      let command: CameraAction
      let requestedCommand: string
      let reason = 'scripted-simulation'
      let confidence: number | null = null
      let probabilities: Record<string, number> = {}
      let elapsedMs = 0
      if (values.mock) {
        const sequence: CameraAction[] = ['focus', 'stay', 'fit', 'spotlight', 'reveal', 'pulse', 'overview', 'stay']
        const desired = sequence[decisions.length % sequence.length]
        command = Object.hasOwn(commands, desired) ? desired : 'stay'
        requestedCommand = command
      } else {
        const response = await queryJev(state, questions)
        const answer = response.answers.camera
        requestedCommand = answer.choice
        const stable = stabilizeAction(answer, commands, pose, atMs, lastMoveEndMs, lastEffectEndMs)
        command = stable.action
        reason = stable.reason
        confidence = answer.confidence
        probabilities = answer.probabilities
        elapsedMs = response.elapsedMs
      }
      const plan = commands[command]
      if (!plan) throw new Error(`Unknown camera command: ${command}`)
      const next = plan.keyframes[plan.keyframes.length - 1]
      for (const point of plan.keyframes) appendPoint(point.atMs, point)
      effects.push(...plan.effects)
      const decision = { atMs, endMs, scene: cue.text, command, requestedCommand, reason, from: pose, to: next, focus: plan.targets[0] || focus, targets: plan.targets, confidence, probabilities, elapsedMs, frame }
      decisions.push(decision)
      pose = next
      const lastMovement = plan.keyframes.filter((point, index, points) => index > 0 && (Math.abs(point.x - points[index - 1].x) + Math.abs(point.y - points[index - 1].y) + Math.abs(point.zoom - points[index - 1].zoom) > 0.0001)).at(-1)
      if (lastMovement) lastMoveEndMs = lastMovement.atMs
      if (plan.effects.length) lastEffectEndMs = plan.effects[plan.effects.length - 1].endMs
      await appendFile(join(output, 'camera-decisions.jsonl'), `${JSON.stringify({ event: 'decision', ...decision })}\n`)
      console.log(`${(atMs / 1000).toFixed(1)}s ${command.padEnd(9)} x=${pose.x.toFixed(3)} y=${pose.y.toFixed(3)} zoom=${pose.zoom.toFixed(2)} | ${cue.text}`)
    }
  }
  if (actionIndex !== executions.length) throw new Error('Could not align every recorded action to rendered captions')
  appendPoint(Math.min(durationMs, keyframes[keyframes.length - 1].atMs + 1800), overview)
  appendPoint(durationMs, overview)
  const cameraPath = { mode: values.mock ? 'mock' : 'jev', sourceRun, durationMs, video, keyframes, effects, decisions }
  await writeFile(join(output, 'camera-path.json'), JSON.stringify(cameraPath, null, 2))
  const effectGraph = buildEffectGraph(effects, video.width, video.height)
  await writeFile(join(output, 'camera-filter.txt'), `${effectGraph.graph ? `${effectGraph.graph};` : ''}[${effectGraph.output}]${buildCameraFilter(keyframes, video.width, video.height)}[camera]`)
  console.log('Rendering camera motion at 60 fps...')
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', baseVideo, '-filter_complex_script', join(output, 'camera-filter.txt'), '-map', '[camera]', '-map', '0:a?', '-map', '0:s?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'copy', '-c:s', 'copy', '-t', String(durationMs / 1000), '-movflags', '+faststart', join(output, 'camera.mp4')], { maxBuffer: 8 * 1024 * 1024 })
  const viewer = await readFile(join(root, 'demo/jev/camera-viewer.html'), 'utf8')
  await writeFile(join(output, 'viewer.html'), viewer.replace('__CAMERA_DATA__', JSON.stringify(cameraPath).replaceAll('<', '\\u003c')))
  console.log(`Video: ${join(output, 'camera.mp4')}`)
  console.log(`Inspector: ${join(output, 'viewer.html')}`)
}

await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
