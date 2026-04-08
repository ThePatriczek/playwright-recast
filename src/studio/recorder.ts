import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import type { RecordOptions, RecordingResult } from './types.js'

/**
 * Phase 1: Launch playwright codegen so the user can click around.
 * Codegen generates a test script from user interactions.
 * Returns path to the generated script.
 */
function runCodegen(url: string, outputDir: string, options: RecordOptions): string {
  const scriptPath = path.join(outputDir, 'recording.ts')

  const args = [
    'codegen',
    '--target', 'playwright-test',
    '--output', scriptPath,
  ]

  if (options.viewport) {
    args.push('--viewport-size', `${options.viewport.width},${options.viewport.height}`)
  }

  if (options.loadStorage) {
    const storagePath = path.resolve(options.loadStorage)
    if (!fs.existsSync(storagePath)) {
      throw new Error(`Storage file not found: ${storagePath}`)
    }
    args.push('--load-storage', storagePath)
  }

  if (options.ignoreHttpsErrors) {
    args.push('--ignore-https-errors')
  }

  args.push(url)

  // Run codegen — blocks until user closes the codegen window
  execFileSync('npx', ['playwright', ...args], {
    stdio: 'inherit',
    cwd: outputDir,
  })

  if (!fs.existsSync(scriptPath)) {
    throw new Error('No script generated. Did you interact with the page before closing?')
  }

  return scriptPath
}

/**
 * Phase 2: Replay the generated script using Playwright Test runner
 * with tracing + video recording enabled.
 *
 * This replaces the previous manual parse-and-replay approach, which
 * broke on getByRole/getByTestId locators and didn't handle navigation
 * auto-waiting. Running through the test runner means ALL codegen
 * output is replayed natively.
 */
function replay(scriptPath: string, outputDir: string, options: RecordOptions): void {
  const storageState = options.loadStorage
    ? JSON.stringify(path.resolve(options.loadStorage))
    : 'undefined'

  const configContent = `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  reporter: 'list',
  timeout: 120_000,
  use: {
    trace: 'on',
    video: {
      mode: 'on',
      size: { width: ${options.viewport.width}, height: ${options.viewport.height} },
    },
    launchOptions: { headless: false },
    storageState: ${storageState},
  },
})
`
  const configPath = path.join(outputDir, 'replay-config.ts')
  fs.writeFileSync(configPath, configContent)

  try {
    // Run the test — allow non-zero exit so we still capture partial traces
    const result = spawnSync('npx', [
      'playwright', 'test',
      path.basename(scriptPath),
      '--config', path.basename(configPath),
    ], {
      stdio: 'inherit',
      cwd: outputDir,
    })

    // Collect trace + video from Playwright's test-results/ directory
    const testResultsDir = path.join(outputDir, 'test-results')
    if (fs.existsSync(testResultsDir)) {
      collectArtifacts(testResultsDir, outputDir)
      fs.rmSync(testResultsDir, { recursive: true, force: true })
    }

    if (result.status !== 0 && !fs.existsSync(path.join(outputDir, 'trace.zip'))) {
      throw new Error('Replay failed and no trace was captured. Check the console output above.')
    }
  } finally {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
  }
}

/**
 * Walk test-results subdirectories and copy trace.zip + .webm to outputDir.
 */
function collectArtifacts(testResultsDir: string, outputDir: string): void {
  for (const entry of fs.readdirSync(testResultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const subdir = path.join(testResultsDir, entry.name)
    for (const file of fs.readdirSync(subdir)) {
      const src = path.join(subdir, file)
      if (file === 'trace.zip') {
        fs.copyFileSync(src, path.join(outputDir, 'trace.zip'))
      } else if (file.endsWith('.webm')) {
        fs.copyFileSync(src, path.join(outputDir, file))
      }
    }
  }
}

/**
 * Record a browser session: codegen → replay with tracing.
 */
export async function record(
  url: string,
  outputDir: string,
  options: RecordOptions,
): Promise<RecordingResult> {
  fs.mkdirSync(outputDir, { recursive: true })

  // Phase 1: Codegen — user clicks around, script is generated
  console.log('📝  Phase 1: Recording interactions via Playwright Codegen...\n')
  const scriptPath = runCodegen(url, outputDir, options)
  const script = fs.readFileSync(scriptPath, 'utf-8')
  const actionCount = (script.match(/await page\./g) ?? []).length
  console.log(`\n✅  Script generated: ${actionCount} actions captured`)

  // Phase 2: Replay with tracing via Playwright Test runner
  console.log('\n🔄  Phase 2: Replaying with tracing enabled...')
  console.log('    The browser will open again to record the trace. This is expected.\n')
  replay(scriptPath, outputDir, options)

  const tracePath = path.join(outputDir, 'trace.zip')

  // Find the recorded video file
  const files = fs.readdirSync(outputDir)
  const videoFile = files.find((f) => f.endsWith('.webm'))
  const videoPath = videoFile ? path.join(outputDir, videoFile) : ''

  // Parse trace for stats
  let traceActionCount = 0
  let durationMs = 0
  if (fs.existsSync(tracePath)) {
    try {
      const { parseTrace } = await import('../parse/trace-parser.js')
      const trace = await parseTrace(tracePath)
      traceActionCount = trace.actions.length
      durationMs = (trace.metadata.endTime as number) - (trace.metadata.startTime as number)
      trace.frameReader.dispose()
    } catch {
      // Non-critical
    }
  }

  return { outputDir, tracePath, videoPath, actionCount: traceActionCount, durationMs }
}
