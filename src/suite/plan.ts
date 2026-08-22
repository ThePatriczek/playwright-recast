import { cardContentForTest, summaryCardContent } from './cards.js'
import { sortByDeclarationOrder } from './manifest.js'
import type {
  CardContent,
  ResolvedSuiteResultPolicy,
  SuiteResultPolicy,
  SuiteSummary,
  SuiteTest,
} from '../types/suite.js'

/**
 * Turns a filtered manifest into an ordered list of things to render.
 *
 * Pure: no ffmpeg, no browser, no pipeline. Every result-policy decision lives
 * here, so what ends up in the video is decided in one readable place.
 */

/** A test clip rendered through the user's own pipeline. */
export interface ClipPlanItem {
  kind: 'clip'
  label: string
  test: SuiteTest & { tracePath: string }
}

/** A generated still — failure, skip, missing recording, or the summary. */
export interface CardPlanItem {
  kind: 'card'
  label: string
  card: CardContent
  test?: SuiteTest
}

/** One segment of the finished video. */
export type PlanItem = ClipPlanItem | CardPlanItem

export function resolveResultPolicy(
  policy: SuiteResultPolicy = {},
): ResolvedSuiteResultPolicy {
  return {
    failures: policy.failures ?? 'card',
    skipped: policy.skipped ?? 'card',
    missingTrace: policy.missingTrace ?? 'card',
    summary: policy.summary ?? true,
  }
}

function hasTrace(test: SuiteTest): test is SuiteTest & { tracePath: string } {
  return typeof test.tracePath === 'string' && test.tracePath.length > 0
}

/**
 * Build the render plan.
 *
 * @param tests    Tests already narrowed to those belonging in this suite.
 * @param policy   Resolved result policy.
 * @param name     Suite name, shown on the summary card.
 * @param summary  Tally shown on the summary card. Counted over the whole run,
 *                 not just the planned items, so the card reports the suite
 *                 result rather than the video's contents.
 */
export function planSuite(
  tests: readonly SuiteTest[],
  policy: ResolvedSuiteResultPolicy,
  name: string,
  summary: SuiteSummary,
): PlanItem[] {
  const items: PlanItem[] = []

  sortByDeclarationOrder(tests).forEach((test, index) => {
    const label = `${String(index).padStart(3, '0')}-${test.id.slice(0, 12)}`

    if (test.status === 'skipped') {
      // A skipped test may still carry a trace from an earlier attempt, but
      // replaying it would show work the run did not actually do.
      if (policy.skipped === 'card') {
        items.push({ kind: 'card', label, card: cardContentForTest(test), test })
      }
      return
    }

    if (test.status === 'passed') {
      if (hasTrace(test)) {
        items.push({ kind: 'clip', label, test })
      } else if (policy.missingTrace === 'card') {
        items.push({ kind: 'card', label, card: cardContentForTest(test), test })
      }
      return
    }

    // failed / timedOut / interrupted
    if (policy.failures === 'omit') return

    const wantsClip = policy.failures === 'clip' || policy.failures === 'clip+card'
    const wantsCard = policy.failures === 'card' || policy.failures === 'clip+card'
    const clipPossible = wantsClip && hasTrace(test)

    if (clipPossible) {
      items.push({ kind: 'clip', label: `${label}-clip`, test })
    }
    // A failure with nothing to show still gets a card, whatever the policy —
    // silently dropping a failed test would misrepresent the run.
    if (wantsCard || !clipPossible) {
      items.push({ kind: 'card', label: `${label}-card`, card: cardContentForTest(test), test })
    }
  })

  if (policy.summary) {
    items.push({ kind: 'card', label: 'summary', card: summaryCardContent(name, summary) })
  }

  return items
}
