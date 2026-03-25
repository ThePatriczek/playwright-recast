import type { MonotonicMs, TraceAction, TraceResource } from '../types/trace'
import type { ActivityType } from '../types/speed'

const USER_ACTION_METHODS = new Set([
  'click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck',
  'selectOption', 'setInputFiles', 'hover', 'tap', 'dragTo',
])

const NAVIGATION_METHODS = new Set([
  'goto', 'goBack', 'goForward', 'reload',
  'waitForNavigation', 'waitForURL', 'waitForLoadState',
])

function isActiveAt(start: MonotonicMs, end: MonotonicMs, time: MonotonicMs): boolean {
  return (time as number) >= (start as number) && (time as number) <= (end as number)
}

/**
 * Classify what's happening at a given point in time.
 * Priority: user-action > navigation > network-wait > idle
 */
export function classifyTimepoint(
  time: MonotonicMs,
  actions: TraceAction[],
  resources: TraceResource[],
): ActivityType {
  // Check for user actions (highest priority)
  for (const action of actions) {
    if (!isActiveAt(action.startTime, action.endTime, time)) continue
    if (USER_ACTION_METHODS.has(action.method)) return 'user-action'
  }

  // Check for navigation
  for (const action of actions) {
    if (!isActiveAt(action.startTime, action.endTime, time)) continue
    if (NAVIGATION_METHODS.has(action.method)) return 'navigation'
  }

  // Check for network activity
  for (const resource of resources) {
    if (isActiveAt(resource.startTime, resource.endTime, time)) return 'network-wait'
  }

  return 'idle'
}
