import { z } from 'zod'
import type { DirectorProvider, DirectorQuestion, DirectorChoice } from '../../types/director.js'

export interface JevDirectorConfig {
  apiKey?: string
  model?: string
  timeoutMs?: number
}

const answerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
})

export function validateDirectorAnswers(payload: unknown, questions: Record<string, DirectorQuestion>): Record<string, DirectorChoice> {
  const { answers } = z.object({ answers: z.record(z.string(), answerSchema) }).parse(payload)
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name]
    if (!answer || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Jev selected an unavailable option for ${name}`)
    const keys = Object.keys(answer.probabilities)
    if (keys.length !== Object.keys(question.criteria).length || keys.some(key => !Object.hasOwn(question.criteria, key))) throw new Error(`Jev returned an invalid distribution for ${name}`)
    const sum = Object.values(answer.probabilities).reduce((total, probability) => total + probability, 0)
    if (Math.abs(sum - 1) > 0.02) throw new Error(`Jev probabilities do not sum to one for ${name}`)
  }
  return answers
}

export function JevDirector(config: JevDirectorConfig = {}): DirectorProvider {
  const apiKey = config.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFE_EKY
  const model = config.model ?? 'jev-latest'
  const timeoutMs = config.timeoutMs ?? 30000
  if (!apiKey?.trim()) throw new Error('JevDirector requires apiKey or TYPESAFE_API_KEY')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Jev timeoutMs must be positive')
  return {
    name: 'jev',
    async decide(request) {
      for (const question of Object.values(request.questions)) {
        const size = Object.keys(question.criteria).length
        if (!size || size > 255) throw new Error('Jev choice questions require 1–255 options')
      }
      const started = performance.now()
      const response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...request }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`Jev API returned HTTP ${response.status}`)
      return { answers: validateDirectorAnswers(await response.json(), request.questions), model, elapsedMs: performance.now() - started }
    },
  }
}
