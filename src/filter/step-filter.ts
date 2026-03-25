import type { ParsedTrace, FilteredTrace, TraceAction, MonotonicMs } from '../types/trace'

/**
 * Filter out actions matching the predicate.
 * Hidden actions are removed from the action list and their time ranges are recorded.
 */
export function filterSteps(
  trace: ParsedTrace,
  predicate: (action: TraceAction) => boolean,
): FilteredTrace {
  const hidden: Array<{ start: MonotonicMs; end: MonotonicMs }> = []
  const visible: TraceAction[] = []

  for (const action of trace.actions) {
    if (predicate(action)) {
      hidden.push({ start: action.startTime, end: action.endTime })
    } else {
      visible.push(action)
    }
  }

  return {
    ...trace,
    originalActions: trace.actions,
    actions: visible,
    hiddenRanges: hidden,
  }
}
