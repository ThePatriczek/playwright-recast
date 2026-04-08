import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { RecordOptions, RecordingResult } from './types.js'

/**
 * Record a browser session with tracing + video in a single phase.
 *
 * Launches Playwright Test with page.pause() which opens the Inspector.
 * User interacts, clicks "Resume" when done → trace + video are saved
 * by the test runner automatically.
 */
export async function record(
  url: string,
  outputDir: string,
  options: RecordOptions,
): Promise<RecordingResult> {
  fs.mkdirSync(outputDir, { recursive: true })

  // Clean up artifacts from previous runs
  for (const f of fs.readdirSync(outputDir)) {
    if (f.endsWith('.webm') || f === 'trace.zip') {
      fs.unlinkSync(path.join(outputDir, f))
    }
  }

  const vw = options.viewport.width
  const vh = options.viewport.height
  const storageLine = options.loadStorage
    ? `  storageState: ${JSON.stringify(path.resolve(options.loadStorage))},`
    : ''

  // Generate a test that opens the Inspector for interactive recording
  const testPath = path.join(outputDir, '_recording-session.ts')
  fs.writeFileSync(testPath, `import { test } from '@playwright/test'
test.use({
  viewport: { width: ${vw}, height: ${vh} },
  ignoreHTTPSErrors: ${options.ignoreHttpsErrors},
${storageLine}
})
test('recording', async ({ page }) => {
  await page.goto(${JSON.stringify(url)}, { timeout: 60_000, waitUntil: 'domcontentloaded' })
  await page.pause()
})
`)

  const configPath = path.join(outputDir, '_recording-config.ts')
  fs.writeFileSync(configPath, `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: ${JSON.stringify(outputDir)},
  outputDir: ${JSON.stringify(path.join(outputDir, 'test-results'))},
  testMatch: '_recording-session.ts',
  timeout: 0,
  reporter: 'list',
  use: {
    trace: 'on',
    video: {
      mode: 'on',
      size: { width: ${vw}, height: ${vh} },
    },
    launchOptions: { headless: false },
  },
})
`)

  try {
    spawnSync('npx', ['playwright', 'test', '--config', configPath], {
      stdio: 'inherit',
      cwd: outputDir,
    })

    // Collect trace + video from test-results/
    const testResultsDir = path.join(outputDir, 'test-results')
    if (fs.existsSync(testResultsDir)) {
      collectArtifacts(testResultsDir, outputDir)
      fs.rmSync(testResultsDir, { recursive: true, force: true })
    }
  } finally {
    for (const f of [testPath, configPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  }

  const tracePath = path.join(outputDir, 'trace.zip')
  const videoPath = path.join(outputDir, 'video.webm')

  // Parse trace for stats
  let actionCount = 0
  let durationMs = 0
  if (fs.existsSync(tracePath)) {
    try {
      const { parseTrace } = await import('../parse/trace-parser.js')
      const trace = await parseTrace(tracePath)
      actionCount = trace.actions.length
      durationMs = (trace.metadata.endTime as number) - (trace.metadata.startTime as number)
      trace.frameReader.dispose()
    } catch {
      // Non-critical
    }
  }

  return {
    outputDir,
    tracePath,
    videoPath: fs.existsSync(videoPath) ? videoPath : '',
    actionCount,
    durationMs,
  }
}

function collectArtifacts(testResultsDir: string, outputDir: string): void {
  for (const entry of fs.readdirSync(testResultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const subdir = path.join(testResultsDir, entry.name)
    for (const file of fs.readdirSync(subdir)) {
      const src = path.join(subdir, file)
      if (file === 'trace.zip') {
        fs.copyFileSync(src, path.join(outputDir, 'trace.zip'))
      } else if (file.endsWith('.webm')) {
        fs.copyFileSync(src, path.join(outputDir, 'video.webm'))
      }
    }
  }
}
