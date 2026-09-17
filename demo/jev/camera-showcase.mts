import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { buildCameraFilter, overview, type CameraKeyframe, type CameraPose, type FocusRegion } from './camera-rig.ts'
import { actionCandidates, buildEffectGraph, planAction, stabilizeAction, type ActionContext, type CameraAction, type CameraEffect, type TargetSample } from './camera-actions.ts'
import { queryJev, type ChoiceQuestion } from './model.ts'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'))
const { values } = parseArgs({ options: { jev: { type: 'boolean', default: false } } })
const output = join(root, 'test-results/jev', `actions-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const width = 1280
const height = 720
const scenes: { action: CameraAction; title: string; durationMs: number; selectors: string[] }[] = [
  { action: 'focus', title: 'FOCUS · přiblížit název projektu', durationMs: 3000, selectors: ['#name'] },
  { action: 'stay', title: 'STAY · nechat čas na přečtení', durationMs: 3000, selectors: ['#name'] },
  { action: 'fit', title: 'FIT · ukázat vstup a výsledek společně', durationMs: 3000, selectors: ['#details', '#ready'] },
  { action: 'follow', title: 'FOLLOW · sledovat přetahovanou kartu', durationMs: 4000, selectors: ['#moving'] },
  { action: 'reveal', title: 'REVEAL · ukázat potvrzení výsledku', durationMs: 3000, selectors: ['#result'] },
  { action: 'overview', title: 'OVERVIEW · vrátit kontext celé stránky', durationMs: 3000, selectors: [] },
  { action: 'spotlight', title: 'SPOTLIGHT · soustředit pozornost bez pohybu', durationMs: 3000, selectors: ['#review'] },
  { action: 'pulse', title: 'PULSE · krátce zvýraznit změnu', durationMs: 3000, selectors: ['#status'] },
]

async function main(): Promise<void> {
  await mkdir(join(output, 'frames'), { recursive: true })
  console.log(`Action showcase: ${output}`)
  const browser = await chromium.launch({ headless: false, channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const keyframes: CameraKeyframe[] = [{ ...overview, atMs: 0 }]
  const effects: CameraEffect[] = []
  const decisions: object[] = []
  const manifest: string[] = []
  let pose: CameraPose = { ...overview }
  let atMs = 0
  let frameIndex = 0
  let lastFrame = ''
  let lastMoveEndMs = -10000
  let lastEffectEndMs = -10000
  const region = async (selector: string): Promise<FocusRegion> => {
    const box = await page.locator(selector).boundingBox()
    if (!box) throw new Error(`Missing showcase target ${selector}`)
    return { x: box.x / width, y: box.y / height, width: box.width / width, height: box.height / height, label: (await page.locator(selector).innerText()) || selector }
  }
  const capture = async (durationMs: number) => {
    lastFrame = `frames/${String(frameIndex++).padStart(4, '0')}.png`
    await page.screenshot({ path: join(output, lastFrame) })
    manifest.push(`file '${lastFrame}'`, `duration ${durationMs / 1000}`)
  }
  try {
    await page.goto(pathToFileURL(join(root, 'demo/jev/camera-stage.html')).href)
    await page.bringToFront()
    for (const scene of scenes) {
      const endMs = atMs + scene.durationMs
      await page.locator('#instruction').evaluate((element, text) => { element.textContent = text }, values.jev ? scene.title.split(' · ')[1] : scene.title)
      await page.locator('#moving').evaluate((element, visible) => { element.toggleAttribute('hidden', !visible) }, scene.action === 'follow')
      await page.locator('#result').evaluate((element, visible) => { element.toggleAttribute('hidden', !visible) }, scene.action === 'reveal')
      const targets = await Promise.all(scene.selectors.map(region))
      const track: TargetSample[] = []
      if (scene.action === 'follow') {
        const box = await page.locator('#moving').boundingBox()
        if (!box) throw new Error('Moving card is missing')
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        for (let elapsed = 0; elapsed < scene.durationMs; elapsed += 100) {
          const progress = elapsed / (scene.durationMs - 100)
          const smooth = progress * progress * (3 - 2 * progress)
          await page.mouse.move(box.x + box.width / 2 + smooth * 750, box.y + box.height / 2 - Math.sin(progress * Math.PI) * 100)
          track.push({ atMs: atMs + elapsed, region: await region('#moving') })
          await capture(100)
        }
        await page.mouse.up()
        track.push({ atMs: endMs, region: await region('#moving') })
      } else {
        await page.mouse.move(1220, 80)
        await capture(scene.durationMs)
        await page.waitForTimeout(500)
      }
      const context: ActionContext = { focus: targets[0], related: targets, result: scene.action === 'reveal' ? targets[0] : undefined, track }
      let action = scene.action
      let requestedCommand: string = action
      let confidence: number | null = null
      let probabilities: Record<string, number> = {}
      let elapsedMs = 0
      let reason = 'scripted-showcase'
      if (values.jev) {
        const candidates = actionCandidates(pose, context, atMs, endMs)
        const state = { goal: scene.title.split(' · ')[1], camera: pose, subjects: context, recentDecisions: decisions.slice(-3), timing: { atMs, endMs, millisecondsSinceLastMove: atMs - lastMoveEndMs, millisecondsSinceLastEffect: atMs - lastEffectEndMs } }
        const questions: Record<string, ChoiceQuestion> = { camera: { type: 'choice', instructions: 'Choose the camera action that best serves the supplied presentation goal. stay keeps the shot still for reading; focus frames one detail; fit frames related subjects together; follow follows measured moving positions; reveal frames a new observed result; overview restores full context; spotlight dims surroundings without moving; pulse briefly highlights a changed status. Prefer stay when there is no clear benefit. Use only the supplied targets and measured positions.', criteria: Object.fromEntries(Object.entries(candidates).map(([name, candidate]) => [name, `${candidate.reason}: ${JSON.stringify(candidate.targets)}; ends at ${JSON.stringify(candidate.keyframes.at(-1))}`])) } }
        const response = await queryJev(state, questions)
        const answer = response.answers.camera
        const stable = stabilizeAction(answer, candidates, pose, atMs, lastMoveEndMs, lastEffectEndMs)
        action = stable.action
        requestedCommand = answer.choice
        confidence = answer.confidence
        probabilities = answer.probabilities
        elapsedMs = response.elapsedMs
        reason = stable.reason
        await writeFile(join(output, `decision-${decisions.length}.json`), JSON.stringify({ state, questions, response }, null, 2))
      }
      const plan = planAction(action, pose, context, atMs, endMs)
      if (!values.jev && plan.action !== scene.action) throw new Error(`Showcase action ${scene.action} could not run: ${plan.reason}`)
      for (const point of plan.keyframes) if (point.atMs > keyframes[keyframes.length - 1].atMs) keyframes.push(point)
      effects.push(...plan.effects)
      const next = plan.keyframes[plan.keyframes.length - 1]
      decisions.push({ atMs, endMs, scene: values.jev ? scene.title.split(' · ')[1] : scene.title, command: plan.action, requestedCommand, reason: `${reason}: ${plan.reason}`, from: pose, to: next, targets: plan.action === 'follow' ? targets : plan.targets, focus: targets[0], track, confidence, probabilities, elapsedMs })
      const lastMovement = plan.keyframes.filter((point, index, points) => index > 0 && (Math.abs(point.x - points[index - 1].x) + Math.abs(point.y - points[index - 1].y) + Math.abs(point.zoom - points[index - 1].zoom) > 0.0001)).at(-1)
      if (lastMovement) lastMoveEndMs = lastMovement.atMs
      if (plan.effects.length) lastEffectEndMs = plan.effects[plan.effects.length - 1].endMs
      console.log(`${atMs / 1000}s ${plan.action} (${requestedCommand}) ${reason}`)
      pose = next
      atMs = endMs
    }
  } finally {
    await browser.close()
  }
  manifest.push(`file '${lastFrame}'`)
  await writeFile(join(output, 'frames.txt'), manifest.join('\n'))
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', join(output, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-t', String(atMs / 1000), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', join(output, 'source.mp4')])
  const effectGraph = buildEffectGraph(effects, width, height)
  await writeFile(join(output, 'camera-filter.txt'), `${effectGraph.graph ? `${effectGraph.graph};` : ''}[${effectGraph.output}]${buildCameraFilter(keyframes, width, height)}[camera]`)
  console.log('Rendering all eight camera actions...')
  await exec('ffmpeg', ['-v', 'error', '-y', '-i', join(output, 'source.mp4'), '-filter_complex_script', join(output, 'camera-filter.txt'), '-map', '[camera]', '-t', String(atMs / 1000), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-movflags', '+faststart', join(output, 'camera.mp4')], { maxBuffer: 8 * 1024 * 1024 })
  const data = { mode: values.jev ? 'jev' : 'showcase', durationMs: atMs, video: { width, height }, keyframes, effects, decisions }
  await writeFile(join(output, 'camera-path.json'), JSON.stringify(data, null, 2))
  await writeFile(join(output, 'camera-decisions.jsonl'), decisions.map(decision => JSON.stringify({ event: 'decision', ...decision })).join('\n'))
  const viewer = await readFile(join(root, 'demo/jev/camera-viewer.html'), 'utf8')
  await writeFile(join(output, 'viewer.html'), viewer.replace('__CAMERA_DATA__', JSON.stringify(data).replaceAll('<', '\\u003c')))
  console.log(`Inspector: ${join(output, 'viewer.html')}`)
}

await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
