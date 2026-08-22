import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Pipeline } from '../pipeline/pipeline.js'
import type {
  SuiteCardConfig,
  SuiteResultPolicy,
  SuiteTest,
  SuiteTransition,
} from '../types/suite.js'

/** A test that reached the clip builder — it is guaranteed to have a trace. */
export type ClipTest = SuiteTest & { tracePath: string }

export interface SuiteConfig {
  /** Shown on the summary card and in log output */
  name: string
  /** Where the finished suite video is written */
  output: string
  /** Keep only tests whose title or tags match */
  grep?: RegExp
  /** Keep only tests from this Playwright project */
  project?: string
  /** Manifest to read (default: `.recast/run.json`) */
  manifest?: string
  /**
   * Build the pipeline for one test. Return `null` to leave the test out.
   *
   * Do not call `toFile()` — the orchestrator runs the pipeline itself and
   * writes to a temporary path before concatenation.
   */
  clip: (test: ClipTest) => Pipeline | null
  /** How non-passing and unrenderable tests appear (see `resolveResultPolicy`) */
  results?: SuiteResultPolicy
  /** Card appearance */
  cards?: SuiteCardConfig
  /** What happens between two segments (default: 'cut') */
  transition?: SuiteTransition
  /** Crossfade length when `transition: 'fade'` (default: 400) */
  transitionDurationMs?: number
}

/**
 * Define a suite video. Identity at runtime — it exists for the types and to
 * give config files a stable, greppable entry point.
 *
 * ```ts
 * // recast.config.ts
 * import { defineSuite, Recast, OpenAIProvider } from 'playwright-recast'
 *
 * export default defineSuite({
 *   name: 'Product walkthrough',
 *   output: 'videos/walkthrough.mp4',
 *   grep: /@video/,
 *   clip: test => Recast
 *     .from(test.tracePath)
 *     .parse()
 *     .speedUp({ duringIdle: 3 })
 *     .subtitlesFromTrace()
 *     .voiceover(OpenAIProvider({ voice: 'nova' }))
 *     .render({ resolution: '1080p' }),
 * })
 * ```
 */
export function defineSuite(config: SuiteConfig): SuiteConfig {
  return config
}

const CONFIG_FILENAMES = [
  'recast.config.ts',
  'recast.config.mts',
  'recast.config.js',
  'recast.config.mjs',
]

/** Find the config file next to the working directory. */
export function findConfigFile(cwd: string = process.cwd()): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(cwd, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/** Pull the suite config out of whatever shape the module exported. */
export function extractSuiteConfig(module: unknown, source: string): SuiteConfig {
  const candidate = (module as { default?: unknown })?.default ?? module

  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`${source} must export a suite config as its default export`)
  }

  const config = candidate as Partial<SuiteConfig>
  if (typeof config.name !== 'string' || config.name === '') {
    throw new Error(`${source}: suite config needs a \`name\``)
  }
  if (typeof config.output !== 'string' || config.output === '') {
    throw new Error(`${source}: suite config needs an \`output\` path`)
  }
  if (typeof config.clip !== 'function') {
    throw new Error(`${source}: suite config needs a \`clip\` function`)
  }

  return config as SuiteConfig
}

/**
 * Load the suite config.
 *
 * TypeScript config files rely on the runtime being able to import them —
 * Node 22.18+ strips types on its own; older versions need `tsx` or a
 * JavaScript config. The error says so rather than surfacing a raw syntax
 * error from deep inside the loader.
 */
export async function loadSuiteConfig(configPath?: string): Promise<SuiteConfig> {
  const resolved = configPath
    ? path.resolve(configPath)
    : findConfigFile()

  if (!resolved) {
    throw new Error(
      `No suite config found. Create one of ${CONFIG_FILENAMES.join(', ')}, ` +
      'or pass --config <path>.',
    )
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Suite config not found: ${resolved}`)
  }

  let module: unknown
  try {
    module = await import(pathToFileURL(resolved).href)
  } catch (err) {
    const isTypeScript = /\.m?ts$/.test(resolved)
    const detail = (err as Error).message
    if (isTypeScript) {
      throw new Error(
        `Could not load ${resolved}: ${detail}\n` +
        'TypeScript configs need Node 22.18+ (type stripping) or a loader — ' +
        'try `npx tsx node_modules/.bin/playwright-recast ...`, or use recast.config.mjs.',
      )
    }
    throw new Error(`Could not load ${resolved}: ${detail}`)
  }

  return extractSuiteConfig(module, path.basename(resolved))
}
