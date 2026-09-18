import { afterEach, describe, expect, it, vi } from 'vitest'
import { JevDirector } from '../../../src/director/providers/jev.js'
import type { DirectorRequest } from '../../../src/types/director.js'

const request: DirectorRequest = { state: { goal: 'Show the result' }, questions: { camera: { type: 'choice', instructions: 'Choose a shot', criteria: { stay: 'Stay', focus: 'Focus' } } } }
const payload = { answers: { camera: { type: 'choice', choice: 'focus', confidence: 0.9, probabilities: { focus: 0.95, stay: 0.05 } } } }

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('Jev director provider', () => {
  it('keeps authentication out of state and returns validated decisions', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)))
    vi.stubGlobal('fetch', fetch)
    const response = await JevDirector({ apiKey: 'test-credential' }).decide(request)
    const [url, options] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(options.headers.Authorization).toBe('Bearer test-credential')
    expect(options.body).not.toContain('test-credential')
    expect(response.answers.camera.choice).toBe('focus')
    expect(JSON.stringify(response)).not.toContain('test-credential')
  })

  it.each([
    { ...payload.answers.camera, choice: 'invented-target' },
    { ...payload.answers.camera, probabilities: { focus: 0.8, stay: 0.8 } },
    { ...payload.answers.camera, probabilities: { focus: 0.9, foreign: 0.1 } },
    { ...payload.answers.camera, confidence: -1 },
  ])('rejects malformed or unavailable model choices', async answer => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { camera: answer } }))))
    await expect(JevDirector({ apiKey: 'test-credential' }).decide(request)).rejects.toThrow()
  })

  it('does not expose an HTTP error body or retry a failed request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('test-credential and private request', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(JevDirector({ apiKey: 'test-credential' }).decide(request)).rejects.toThrow('Jev API returned HTTP 401')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('requires a key without reading a local dotenv file implicitly', () => {
    vi.stubEnv('TYPESAFE_API_KEY', '')
    vi.stubEnv('TYPESAFE_EKY', '')
    expect(() => JevDirector()).toThrow('requires apiKey')
  })
})
