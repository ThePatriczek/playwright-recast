import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCandidates, queryJev, requireConfidence, scenarioSchema, validateAnswers, type BrowserState, type ChoiceQuestion } from '../../../demo/jev/model.js'

const questions: Record<string, ChoiceQuestion> = {
  action: { type: 'choice', instructions: 'Choose an action', criteria: { click_save: 'Save the project', wait: 'Wait' } },
}

const response = (choice = 'click_save', confidence = 0.8) => ({
  answers: { action: { type: 'choice', choice, confidence, probabilities: { click_save: 0.9, wait: 0.1 } } },
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('Jev decision boundary', () => {
  it('rejects a fabricated action even when the response has the right types', () => {
    expect(() => validateAnswers(response('delete_everything'), questions)).toThrow('unavailable option')
  })

  it('stops uncertain browser actions', () => {
    const answers = validateAnswers(response('click_save', 0.1), questions)
    expect(() => requireConfidence(answers.action, 0.35)).toThrow('below the configured threshold')
  })

  it('rejects incomplete distributions', () => {
    const payload = response()
    payload.answers.action.probabilities.click_save = 0.2
    expect(() => validateAnswers(payload, questions)).toThrow('sum to one')
  })

  it('sends the documented API shape and honors TYPESAFE_EKY', async () => {
    vi.stubEnv('TYPESAFE_EKY', 'test-only-key')
    vi.stubEnv('TYPESAFE_MODEL', 'jev-latest')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response())))
    vi.stubGlobal('fetch', fetchMock)
    const state = { goal: 'Save a project', controls: ['Save'] }
    const result = await queryJev(state, questions)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(JSON.parse(request.body)).toEqual({ model: 'jev-latest', state, questions })
    expect(request.headers.Authorization).toBe('Bearer test-only-key')
    expect(result.answers.action.choice).toBe('click_save')
    expect(JSON.stringify(result)).not.toContain('test-only-key')
  })

  it('reports an API rejection without leaking its body', async () => {
    vi.stubEnv('TYPESAFE_EKY', 'test-only-key')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private server diagnostic', { status: 401 })))
    await expect(queryJev({}, questions)).rejects.toThrow('TypeSafe API returned HTTP 401')
  })

  it('offers only configured edits and excludes disabled controls', () => {
    const state: BrowserState = {
      url: 'http://localhost', title: 'Demo', text: '', scroll: { y: 0, max: 0, viewportHeight: 720 },
      controls: [
        { ref: 'name', tag: 'input', role: 'input', label: 'Name', inputType: 'text', value: '', checked: false, enabled: true, editable: true, options: [], box: { x: 0, y: 0, width: 100, height: 30 } },
        { ref: 'disabled', tag: 'button', role: 'button', label: 'Save', inputType: '', value: '', checked: false, enabled: false, editable: false, options: [], box: { x: 0, y: 40, width: 100, height: 30 } },
      ],
    }
    const scenario = scenarioSchema.parse({ goal: 'Create', inputs: [{ label: 'Name', value: 'Atlas' }], success: { selector: '#done', text: 'Created' } })
    const actions = Object.values(makeCandidates(state, scenario))
    expect(actions.map(action => action.kind)).toEqual(['fill', 'wait', 'abort'])
    expect(actions[0]).toMatchObject({ kind: 'fill', value: 'Atlas', target: { ref: 'name' } })
  })
})
