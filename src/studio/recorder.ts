import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
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
 * Phase 2: Replay the generated script with tracing + video recording.
 * Produces trace.zip and .webm in outputDir.
 */
async function replay(scriptPath: string, outputDir: string, options: RecordOptions): Promise<void> {
  const { chromium } = await import('playwright')

  const browser = await chromium.launch({ headless: false })

  const context = await browser.newContext({
    viewport: options.viewport,
    recordVideo: {
      dir: outputDir,
      size: options.viewport,
    },
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
  })

  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()

  // Parse the generated script and execute the actions
  const script = fs.readFileSync(scriptPath, 'utf-8')
  const actions = parseCodegenScript(script)

  for (const action of actions) {
    try {
      switch (action.method) {
        case 'goto':
          await page.goto(action.args[0]!)
          break
        case 'click':
          await page.locator(action.args[0]!).click()
          break
        case 'fill':
          await page.locator(action.args[0]!).fill(action.args[1]!)
          break
        case 'press':
          await page.locator(action.args[0]!).press(action.args[1]!)
          break
        case 'selectOption':
          await page.locator(action.args[0]!).selectOption(action.args[1]!)
          break
        case 'check':
          await page.locator(action.args[0]!).check()
          break
        case 'uncheck':
          await page.locator(action.args[0]!).uncheck()
          break
        case 'dblclick':
          await page.locator(action.args[0]!).dblclick()
          break
        case 'hover':
          await page.locator(action.args[0]!).hover()
          break
        default:
          console.log(`  Skipping unknown action: ${action.method}`)
      }
    } catch (err) {
      console.log(`  Warning: action ${action.method}(${action.args[0]}) failed: ${(err as Error).message}`)
    }
  }

  // Small pause so the last frame renders
  await page.waitForTimeout(1000)

  const tracePath = path.join(outputDir, 'trace.zip')
  await context.tracing.stop({ path: tracePath })
  await browser.close()
}

/** Parsed action from codegen output */
interface CodegenAction {
  method: string
  args: string[]
}

/**
 * Parse a playwright codegen-generated script into a list of actions.
 * Extracts page.goto(), locator.click(), locator.fill(), etc.
 */
function parseCodegenScript(script: string): CodegenAction[] {
  const actions: CodegenAction[] = []

  // Match page.goto('...')
  for (const match of script.matchAll(/page\.goto\('([^']+)'\)/g)) {
    actions.push({ method: 'goto', args: [match[1]!] })
  }

  // Match page.locator('...').method('...')  or  page.locator('...').method()
  // Also handles getByRole, getByText, getByLabel, getByPlaceholder etc.
  const locatorPattern = /page\.(locator|getByRole|getByText|getByLabel|getByPlaceholder|getByTestId)\(([^)]+)\)\.(click|fill|press|selectOption|check|uncheck|dblclick|hover)\(([^)]*)\)/g

  for (const match of script.matchAll(locatorPattern)) {
    const selectorRaw = match[2]!
    const method = match[3]!
    const argsRaw = match[4]!

    // Build the selector string for page.locator()
    const locatorMethod = match[1]!
    let selector: string

    if (locatorMethod === 'locator') {
      // locator('selector') → extract the string
      selector = extractString(selectorRaw)
    } else {
      // getByRole('button', { name: 'Submit' }) → reconstruct as role=button[name="Submit"]
      selector = `${locatorMethod}(${selectorRaw})`
    }

    const args = [selector]
    if (argsRaw.trim()) {
      args.push(extractString(argsRaw))
    }

    actions.push({ method, args })
  }

  // Sort by order of appearance in the script
  // (matchAll already returns in order)

  return actions
}

/** Extract a string value from a JS expression like 'hello' or "hello" */
function extractString(raw: string): string {
  const trimmed = raw.trim()
  // Single or double quoted string
  const strMatch = trimmed.match(/^['"](.+?)['"]/)
  if (strMatch) return strMatch[1]!
  return trimmed
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
  const actionCount = parseCodegenScript(script).length
  console.log(`\n✅  Script generated: ${actionCount} actions captured`)

  // Phase 2: Replay with tracing
  console.log('\n🔄  Phase 2: Replaying with tracing enabled...\n')
  await replay(scriptPath, outputDir, options)

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
