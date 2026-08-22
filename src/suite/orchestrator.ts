import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { probeResolution } from '../render/renderer.js'
import { concatVideos, crossfadeVideos, probeFps } from '../render/video-ops.js'
import { CardRenderer, cardContentForTest, resolveCardConfig } from './cards.js'
import type { SuiteConfig } from './config.js'
import { DEFAULT_MANIFEST_PATH, filterTests, readManifest } from './manifest.js'
import { planSuite, resolveResultPolicy, type CardPlanItem, type PlanItem } from './plan.js'
import type { RunManifest } from '../types/suite.js'

const DEFAULT_TRANSITION_MS = 400

export interface RenderSuiteOptions {
  /** Override the manifest path from the config */
  manifest?: string
  /** Override the output path from the config */
  output?: string
  /** Keep the temporary clip directory around for inspection */
  keepClips?: boolean
}

export interface RenderSuiteResult {
  outputPath: string
  /** Segments that made it into the video */
  segments: number
  /** Tests whose clip render threw and fell back to a card */
  degraded: string[]
  manifest: RunManifest
}

/**
 * Render one suite video from a run manifest.
 *
 * Each planned clip runs through the user's own pipeline, cards are
 * screenshotted, and everything is concatenated in declaration order. A clip
 * that fails to render degrades to a card rather than losing the whole run —
 * one unreadable trace should not cost you the other twelve tests.
 */
export async function renderSuite(
  config: SuiteConfig,
  options: RenderSuiteOptions = {},
): Promise<RenderSuiteResult> {
  const manifestPath = options.manifest ?? config.manifest ?? DEFAULT_MANIFEST_PATH
  const outputPath = path.resolve(options.output ?? config.output)
  const manifest = readManifest(manifestPath)

  const selected = filterTests(manifest.tests, {
    ...(config.grep ? { grep: config.grep } : {}),
    ...(config.project ? { project: config.project } : {}),
  })

  if (selected.length === 0) {
    throw new Error(
      `No tests matched in ${manifestPath}` +
      (config.grep ? ` for grep ${String(config.grep)}` : '') +
      (config.project ? ` in project ${config.project}` : ''),
    )
  }

  const policy = resolveResultPolicy(config.results)
  const plan = planSuite(selected, policy, config.name, manifest.summary)

  if (plan.length === 0) {
    throw new Error('Nothing to render — every test was excluded by the result policy')
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recast-suite-'))
  const degraded: string[] = []

  try {
    const { segments, cardRenderer } = await renderSegments(config, plan, tmpDir, degraded)

    try {
      if (segments.length === 0) {
        throw new Error('No segment rendered successfully — cannot write a suite video')
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      joinSegments(segments, config, tmpDir, outputPath)

      return { outputPath, segments: segments.length, degraded, manifest }
    } finally {
      await cardRenderer?.close()
    }
  } finally {
    if (options.keepClips) {
      console.log(`  Suite: clips kept in ${tmpDir}`)
    } else {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }
}

/**
 * Render every planned segment to its own file.
 *
 * Clips render first so the card renderer can match their resolution and fps —
 * a 1080p card in front of a 720p suite would force a needless re-encode of
 * every clip.
 */
async function renderSegments(
  config: SuiteConfig,
  plan: readonly PlanItem[],
  tmpDir: string,
  degraded: string[],
): Promise<{ segments: string[]; cardRenderer: CardRenderer | undefined }> {
  const rendered = new Map<string, string>()
  const cardFallbacks: CardPlanItem[] = []

  for (const item of plan) {
    if (item.kind !== 'clip') continue

    const clipPath = path.join(tmpDir, `clip-${item.label}.mp4`)
    console.log(`  Suite: rendering ${item.test.title}`)

    try {
      const pipeline = config.clip(item.test)
      if (!pipeline) continue
      await pipeline.toFile(clipPath)
      rendered.set(item.label, clipPath)
    } catch (err) {
      console.warn(`  Suite: clip failed for "${item.test.title}" — ${(err as Error).message}`)
      degraded.push(item.test.title)
      cardFallbacks.push({
        kind: 'card',
        label: item.label,
        card: cardContentForTest(item.test),
        test: item.test,
      })
    }
  }

  const fallbackByLabel = new Map(cardFallbacks.map(item => [item.label, item]))
  const cardItems: CardPlanItem[] = [
    ...plan.filter((item): item is CardPlanItem => item.kind === 'card'),
    ...cardFallbacks,
  ]

  let cardRenderer: CardRenderer | undefined
  if (cardItems.length > 0) {
    const reference = [...rendered.values()][0]
    // Cards inherit the first clip's geometry; with no clips at all, fall back
    // to 1080p30 and let concat normalize.
    const size = reference ? probeResolution(reference) : { width: 1920, height: 1080 }
    const fps = reference ? probeFps(reference) : 30

    cardRenderer = new CardRenderer(resolveCardConfig(config.cards), size, Math.round(fps), tmpDir)

    for (const item of cardItems) {
      rendered.set(item.label, await cardRenderer.render(item.card, item.label))
    }
  }

  // Walk the plan again so the output keeps declaration order, with each
  // failed clip replaced in place by its card.
  const segments: string[] = []
  for (const item of plan) {
    const fallback = item.kind === 'clip' ? fallbackByLabel.get(item.label) : undefined
    const rendersAs = fallback ?? item
    const file = rendered.get(rendersAs.label)
    if (file) segments.push(file)
  }

  return { segments, cardRenderer }
}

/** Join rendered segments into the final file. */
function joinSegments(
  segments: readonly string[],
  config: SuiteConfig,
  tmpDir: string,
  outputPath: string,
): void {
  if (config.transition !== 'fade') {
    concatVideos(segments, tmpDir, outputPath)
    return
  }

  const fadeMs = config.transitionDurationMs ?? DEFAULT_TRANSITION_MS
  let current = segments[0]!

  for (let i = 1; i < segments.length; i++) {
    const merged = path.join(tmpDir, `xfade-${i}.mp4`)
    crossfadeVideos(current, segments[i]!, fadeMs, tmpDir, merged)
    current = merged
  }

  fs.copyFileSync(current, outputPath)
}
