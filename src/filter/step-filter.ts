import type { ParsedTrace, FilteredTrace, TraceAction, MonotonicMs } from '../types/trace.js'

/**
 * Filter out actions matching the predicate.
 * Hidden actions are removed from the action list and their time ranges are recorded.
 * Child actions whose time falls inside a hidden range are also removed, so that
 * downstream stages (clickEffect, cursorOverlay, subtitles) do not surface clicks
 * or cursor motion from inside a hidden parent step like `test.step('login', ...)`.
 */
export function filterSteps(
  trace: ParsedTrace,
  predicate: (action: TraceAction) => boolean,
): FilteredTrace {
  const hidden: Array<{ start: MonotonicMs; end: MonotonicMs }> = []
  const remaining: TraceAction[] = []

  for (const action of trace.actions) {
    if (predicate(action)) {
      hidden.push({ start: action.startTime, end: action.endTime })
    } else {
      remaining.push(action)
    }
  }

  const visible = remaining.filter((action) => {
    const t = action.startTime as number
    return !hidden.some((r) => t >= (r.start as number) && t < (r.end as number))
  })

  return {
    ...trace,
    originalActions: trace.actions,
    actions: visible,
    hiddenRanges: hidden,
  }
}
