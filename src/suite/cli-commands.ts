import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadSuiteConfig } from './config.js'
import { renderSuite } from './orchestrator.js'
import { buildPlaywrightArgs, parseSuiteArgs } from './cli-args.js'

/**
 * The `render-suite` and `test` subcommands. Kept out of `cli.ts` so the
 * single-trace path stays as small as it was.
 */

export const suiteHelp = `
SUITE COMMANDS
  playwright-recast render-suite [options]
      Render one video from an existing run manifest.

  playwright-recast test [options] [-- <playwright args>]
      Run Playwright, then render the suite video. Exits with Playwright's
      own exit code, so a red suite stays red.

SUITE OPTIONS
  -c, --config <path>   Suite config (default: ./recast.config.ts)
      --manifest <path> Run manifest (default: .recast/run.json)
  -o, --output <path>   Output video (default: the config's \`output\`)
      --keep-clips      Keep the temporary per-test clips
      --inject-reporter Append the recast reporter to the playwright command.
                        Only for a quick start — it replaces the reporters in
                        playwright.config.ts. Prefer registering the reporter
                        there instead.

SUITE EXAMPLES
  playwright-recast test -- --project=chromium --grep=@video
  playwright-recast render-suite --manifest .recast/run.json -o videos/demo.mp4
`.trim()

/** Absolute path to the built reporter module, for --inject-reporter. */
function reporterModulePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'reporter.js')
}

/** Render a suite video from an existing manifest. */
export async function runRenderSuite(argv: readonly string[]): Promise<number> {
  const args = parseSuiteArgs(argv)
  const config = await loadSuiteConfig(args.config)

  console.log(`Suite: ${config.name}`)
  const result = await renderSuite(config, {
    ...(args.manifest !== undefined ? { manifest: args.manifest } : {}),
    ...(args.output !== undefined ? { output: args.output } : {}),
    keepClips: args.keepClips,
  })

  console.log(`Done! ${result.segments} segments written to: ${result.outputPath}`)
  if (result.degraded.length > 0) {
    console.log(`Degraded to cards: ${result.degraded.join(', ')}`)
  }
  return 0
}

/**
 * Run Playwright, then render.
 *
 * The video is rendered whatever the tests did — a failing suite is exactly
 * when you want to see what happened — but the process still exits with
 * Playwright's code so CI is not misled by a successful render.
 */
export async function runTest(argv: readonly string[]): Promise<number> {
  const args = parseSuiteArgs(argv)
  // Fail on a bad config before spending a whole test run on it.
  const config = await loadSuiteConfig(args.config)

  const playwrightArgs = buildPlaywrightArgs(args.passthrough, {
    injectReporter: args.injectReporter,
    reporterPath: reporterModulePath(),
  })

  console.log(`Running: npx ${playwrightArgs.join(' ')}`)
  const run = spawnSync('npx', playwrightArgs, { stdio: 'inherit' })

  if (run.error) {
    throw new Error(`Could not run playwright: ${run.error.message}`)
  }
  const playwrightExitCode = run.status ?? 1

  console.log(`\nSuite: ${config.name}`)
  try {
    const result = await renderSuite(config, {
      ...(args.manifest !== undefined ? { manifest: args.manifest } : {}),
      ...(args.output !== undefined ? { output: args.output } : {}),
      keepClips: args.keepClips,
    })
    console.log(`Done! ${result.segments} segments written to: ${result.outputPath}`)
    if (result.degraded.length > 0) {
      console.log(`Degraded to cards: ${result.degraded.join(', ')}`)
    }
  } catch (err) {
    // Rendering is downstream of the tests: report the failure, but never let
    // it turn a green suite red or mask a red one.
    console.error(`Suite render failed: ${(err as Error).message}`)
    if (playwrightExitCode === 0) return 1
  }

  return playwrightExitCode
}
