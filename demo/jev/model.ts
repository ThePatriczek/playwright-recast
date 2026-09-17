import { z } from 'zod'

export const scenarioSchema = z.object({
  goal: z.string().min(1),
  inputs: z.array(z.object({ label: z.string().min(1), value: z.string() })),
  success: z.object({ selector: z.string().min(1), text: z.string().min(1) }),
  root: z.string().default('body'),
  maxSteps: z.number().int().positive().max(100).default(20),
  minConfidence: z.number().min(0).max(1).default(0.35),
})

export type Scenario = z.infer<typeof scenarioSchema>

export type Control = {
  ref: string
  tag: string
  role: string
  label: string
  inputType: string
  value: string
  checked: boolean
  enabled: boolean
  editable: boolean
  options: { value: string; label: string; disabled: boolean }[]
  box: { x: number; y: number; width: number; height: number }
}

export type BrowserState = {
  url: string
  title: string
  text: string
  controls: Control[]
  scroll: { y: number; max: number; viewportHeight: number }
}

export type Action =
  | { kind: 'click' | 'hover' | 'toggle'; target: Control; description: string }
  | { kind: 'fill' | 'select'; target: Control; value: string; description: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; description: string }
  | { kind: 'wait' | 'abort'; description: string }

export type ChoiceQuestion = {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}

const choiceSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
})

export type ChoiceAnswer = z.infer<typeof choiceSchema>

export function validateAnswers(
  payload: unknown,
  questions: Record<string, ChoiceQuestion>,
): Record<string, ChoiceAnswer> {
  const { answers } = z.object({ answers: z.record(z.string(), choiceSchema) }).parse(payload)
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name]
    if (!answer || !Object.hasOwn(question.criteria, answer.choice)) {
      throw new Error(`Model selected an unavailable option for ${name}`)
    }
    const keys = Object.keys(answer.probabilities)
    if (keys.length !== Object.keys(question.criteria).length || keys.some(key => !Object.hasOwn(question.criteria, key))) {
      throw new Error(`Model returned an invalid distribution for ${name}`)
    }
    const sum = Object.values(answer.probabilities).reduce((total, value) => total + value, 0)
    if (Math.abs(sum - 1) > 0.02) throw new Error(`Model probabilities do not sum to one for ${name}`)
  }
  return answers
}

export function requireConfidence(answer: ChoiceAnswer, minimum: number): void {
  if (answer.confidence < minimum) {
    throw new Error(`Decision confidence ${answer.confidence.toFixed(3)} is below the configured threshold ${minimum}`)
  }
}

export function makeCandidates(state: BrowserState, scenario: Scenario): Record<string, Action> {
  const actions: Action[] = []
  for (const target of state.controls.filter(control => control.enabled)) {
    if (target.editable) {
      for (const input of scenario.inputs.filter(input => input.label === target.label && input.value !== target.value)) {
        actions.push({ kind: 'fill', target, value: input.value, description: `Fill ${target.label} with ${JSON.stringify(input.value)}` })
      }
    } else if (target.tag === 'select') {
      for (const option of target.options.filter(option => !option.disabled && option.value !== target.value)) {
        actions.push({ kind: 'select', target, value: option.value, description: `Select ${option.label} in ${target.label}` })
      }
    } else if (['checkbox', 'radio'].includes(target.inputType) || ['checkbox', 'switch'].includes(target.role)) {
      actions.push({ kind: 'toggle', target, description: `${target.checked ? 'Uncheck' : 'Check'} ${target.label}` })
    } else {
      actions.push({ kind: 'click', target, description: `Click ${target.label}` })
      actions.push({ kind: 'hover', target, description: `Hover ${target.label} to reveal a tooltip without clicking` })
    }
  }
  if (state.scroll.y > 0) actions.push({ kind: 'scroll', direction: 'up', description: 'Scroll the page up by half a viewport' })
  if (state.scroll.y < state.scroll.max - 2) actions.push({ kind: 'scroll', direction: 'down', description: 'Scroll the page down by half a viewport' })
  actions.push({ kind: 'wait', description: 'Wait briefly for loading or an animation to finish' })
  actions.push({ kind: 'abort', description: 'Stop because the goal cannot be completed with the available actions or input data' })
  if (actions.length > 255) throw new Error('More than 255 actions: narrow the scenario root selector')
  return Object.fromEntries(actions.map((action, index) => [`action_${index}`, action]))
}

export async function queryJev(
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
): Promise<{ answers: Record<string, ChoiceAnswer>; elapsedMs: number; model: string }> {
  const apiKey = process.env.TYPESAFE_EKY || process.env.TYPESAFE_API_KEY
  if (!apiKey) throw new Error('Set TYPESAFE_EKY in .env or use --mock')
  const model = process.env.TYPESAFE_MODEL || 'jev-latest'
  const started = performance.now()
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`TypeSafe API returned HTTP ${response.status}`)
  return { answers: validateAnswers(await response.json(), questions), elapsedMs: performance.now() - started, model }
}
