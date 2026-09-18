import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { Recast, JevDirector, VideoObserver, type DirectorReport } from '../../dist/index.js'

const root = resolve(import.meta.dirname, '../..')
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'))
const output = join(root, 'test-results/jev', `api-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const recording = join(output, 'recording')
await mkdir(recording, { recursive: true })
console.log(`Public API demo: ${output}`)
const browser = await chromium.launch({ headless: false, channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: recording, size: { width: 1280, height: 720 } } })
try {
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  await page.goto(pathToFileURL(join(root, 'demo/jev/api-demo.html')).href)
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: 'Generate report' }).click()
  await expect(page.getByText('Report generation failed')).toBeVisible()
  await page.waitForTimeout(3500)
  await page.getByRole('button', { name: 'Generate report' }).click()
  await expect(page.getByText('EUR 124,500')).toBeVisible()
  await page.waitForTimeout(4500)
  await context.tracing.stop({ path: join(recording, 'trace.zip') })
} finally {
  await context.close()
  await browser.close()
}

const observer = VideoObserver()
await Recast.from(recording)
  .parse()
  .direct(JevDirector(), {
    goal: 'Show how to generate a revenue report, notice the failure, retry, and read the final revenue and growth. Direct attention to the report result when it appears away from the Generate button. Ignore the unrelated background sync notice. Keep the camera still while waiting. Establish a useful detail of a relevant result, then stay long enough to read it.',
    sampleIntervalMs: 750,
    maxDecisions: 30,
    observer: {
      name: observer.name,
      async observe(input) {
        await copyFile(input.videoPath, join(output, 'source.mp4'))
        return observer.observe(input)
      },
    },
    onDecision: decision => { console.log(`${(decision.sourceStartMs / 1000).toFixed(1)}s ${decision.action} / ${decision.tempo} (${decision.reason})`) },
  })
  .render({ resolution: '720p', fps: 60 })
  .toFile(join(output, 'camera.mp4'))

const report: DirectorReport = JSON.parse(await readFile(join(output, 'camera.director.json'), 'utf8'))
const data = {
  mode: 'jev', evidence: 'video', durationMs: report.outputDurationMs, keyframes: report.keyframes,
  observations: report.observations,
  decisions: report.decisions.map(decision => {
    const observation = report.observations.filter(item => item.atMs <= decision.sourceStartMs).at(-1)
    const targets = observation?.regions.filter(region => decision.targetIds.includes(region.id)).map(region => ({ ...region, label: region.text })) ?? []
    return { atMs: decision.outputStartMs, endMs: decision.outputEndMs, sourceStartMs: decision.sourceStartMs, sourceEndMs: decision.sourceEndMs, speed: decision.speed, holdMs: decision.holdMs, scene: targets.map(target => target.label).join(' · ') || 'Overview / waiting', command: decision.action, requestedCommand: decision.requestedAction, reason: `${decision.reason} · tempo ${decision.tempo}`, from: decision.from, to: decision.to, targets, confidence: decision.response.answers.camera.confidence, probabilities: decision.response.answers.camera.probabilities, elapsedMs: decision.response.elapsedMs }
  }),
}
await writeFile(join(output, 'camera-path.json'), JSON.stringify(data, null, 2))
await writeFile(join(output, 'camera-decisions.jsonl'), report.decisions.map(decision => JSON.stringify(decision)).join('\n'))
const viewer = await readFile(join(root, 'demo/jev/camera-viewer.html'), 'utf8')
await writeFile(join(output, 'viewer.html'), viewer.replace('__CAMERA_DATA__', JSON.stringify(data).replaceAll('<', '\\u003c')))
console.log(`Inspector: ${join(output, 'viewer.html')}`)
