import { parseArgs } from 'node:util'

/**
 * Argument handling for the suite subcommands, kept separate from the CLI's
 * side effects so dispatch and passthrough rules are testable.
 */

export type Command = 'render' | 'render-suite' | 'test'

const SUBCOMMANDS: readonly string[] = ['render-suite', 'test']

/**
 * Split argv into a subcommand and its arguments.
 *
 * Only a leading bare word can be a subcommand, so the original flag-only form
 * (`playwright-recast -i trace.zip`) keeps working, and a flag *value* that
 * happens to read `test` is never mistaken for one.
 */
export function splitCommand(argv: readonly string[]): { command: Command; rest: string[] } {
  const first = argv[0]
  if (first !== undefined && SUBCOMMANDS.includes(first)) {
    return { command: first as Command, rest: argv.slice(1) }
  }
  return { command: 'render', rest: [...argv] }
}

export interface SuiteArgs {
  config?: string
  manifest?: string
  output?: string
  keepClips: boolean
  injectReporter: boolean
  /** Arguments after `--`, forwarded to `playwright test` verbatim */
  passthrough: string[]
}

/**
 * Parse the flags shared by `render-suite` and `test`.
 * Everything after `--` belongs to Playwright and is never validated here.
 */
export function parseSuiteArgs(argv: readonly string[]): SuiteArgs {
  const separator = argv.indexOf('--')
  const own = separator === -1 ? [...argv] : argv.slice(0, separator)
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1)

  const { values } = parseArgs({
    args: own,
    options: {
      config: { type: 'string', short: 'c' },
      manifest: { type: 'string' },
      output: { type: 'string', short: 'o' },
      'keep-clips': { type: 'boolean', default: false },
      'inject-reporter': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  return {
    ...(values.config !== undefined ? { config: values.config } : {}),
    ...(values.manifest !== undefined ? { manifest: values.manifest } : {}),
    ...(values.output !== undefined ? { output: values.output } : {}),
    keepClips: values['keep-clips'] === true,
    injectReporter: values['inject-reporter'] === true,
    passthrough: [...passthrough],
  }
}

export interface PlaywrightArgOptions {
  injectReporter: boolean
  /** Absolute path to the built reporter module */
  reporterPath: string
}

/**
 * Build the argv for `npx playwright test`.
 *
 * Injection is opt-in and never overrides a `--reporter` the caller supplied,
 * because `--reporter` replaces the reporters configured in
 * playwright.config.ts wholesale — silently discarding someone's HTML report
 * would be a rude way to render a video.
 */
export function buildPlaywrightArgs(
  passthrough: readonly string[],
  options: PlaywrightArgOptions,
): string[] {
  const args = ['playwright', 'test', ...passthrough]

  const callerSetReporter = passthrough.some(
    arg => arg === '--reporter' || arg.startsWith('--reporter='),
  )
  if (options.injectReporter && !callerSetReporter) {
    args.push(`--reporter=list,${options.reporterPath}`)
  }

  return args
}
