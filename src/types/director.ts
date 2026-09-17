import type { SubtitleEntry } from './subtitle.js'

export type DirectorAction = 'focus' | 'fit' | 'follow' | 'reveal' | 'overview' | 'spotlight' | 'pulse' | 'stay'
export type DirectorTempo = 'normal' | 'fast' | 'read' | 'hold'

export interface VisualRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string
  kind: 'text' | 'change'
  changed: boolean
}

export interface VisualObservation {
  atMs: number
  regions: VisualRegion[]
  changeFraction: number
}

export interface VideoObservationInput {
  videoPath: string
  workDir: string
  width: number
  height: number
  durationMs: number
  sampleIntervalMs: number
  maxFrames: number
}

export interface VisualObserver {
  name: string
  observe(input: VideoObservationInput): Promise<VisualObservation[]>
}

export interface DirectorChoice {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface DirectorQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

export interface DirectorRequest {
  state: Record<string, unknown>
  questions: Record<string, DirectorQuestion>
}

export interface DirectorResponse {
  answers: Record<string, DirectorChoice>
  model: string
  elapsedMs: number
}

export interface DirectorProvider {
  name: string
  decide(request: DirectorRequest): Promise<DirectorResponse>
}

export interface DirectorPose {
  x: number
  y: number
  zoom: number
}

export interface DirectorDecision {
  sourceStartMs: number
  sourceEndMs: number
  outputStartMs: number
  outputEndMs: number
  action: DirectorAction
  requestedAction: string
  targetIds: string[]
  tempo: DirectorTempo
  requestedTempo: string
  speed: number
  holdMs: number
  reason: string
  tempoReason: string
  from: DirectorPose
  to: DirectorPose
  response: DirectorResponse
}

export interface DirectorOptions {
  goal: string
  observer?: VisualObserver
  sampleIntervalMs?: number
  decisionIntervalMs?: number
  maxFrames?: number
  maxDecisions?: number
  minConfidence?: number
  minAdvantage?: number
  minimumHoldMs?: number
  maxZoom?: number
  timing?: 'adaptive' | 'preserve'
  reportPath?: string
  onDecision?: (decision: DirectorDecision) => void | Promise<void>
}

export interface DirectorReport {
  version: 1
  provider: string
  observer: string
  goal: string
  sourceDurationMs: number
  outputDurationMs: number
  timingLocked: boolean
  observations: VisualObservation[]
  requests: DirectorRequest[]
  decisions: DirectorDecision[]
  keyframes: Array<DirectorPose & { atMs: number }>
  subtitles: SubtitleEntry[]
}
