import { describe, it, expect, beforeEach } from 'vitest'
import type { TestInfo, Locator } from '@playwright/test'
import {
  zoom,
  highlight,
  setupRecast,
  HIGHLIGHT_TITLE_PREFIX,
  ZOOM_TITLE_PREFIX,
} from '../../../src/helpers'

type StepRecord = { title: string }

function makeFakeTest() {
  const annotations: Array<{ type: string; description?: string }> = []
  const steps: StepRecord[] = []
  const info = { annotations } as unknown as TestInfo
  return {
    info,
    annotations,
    steps,
    fakeTest: {
      info: () => info,
      step: async <T,>(title: string, body: () => T | Promise<T>): Promise<T> => {
        steps.push({ title })
        return body()
      },
    },
  }
}

function makeFakeLocator(box: { x: number; y: number; width: number; height: number } | null) {
  return {
    page: () => ({ viewportSize: () => ({ width: 1280, height: 720 }) }),
    boundingBox: async () => box,
  } as unknown as Locator
}

describe('zoom() — marker contract', () => {
  let env: ReturnType<typeof makeFakeTest>

  beforeEach(() => {
    env = makeFakeTest()
    setupRecast(env.fakeTest)
  })

  it('pushes a zoom annotation and a marker step with JSON-parseable payload', async () => {
    const locator = makeFakeLocator({ x: 128, y: 72, width: 256, height: 144 })

    await zoom(locator, 1.5)

    expect(env.annotations).toHaveLength(1)
    expect(env.annotations[0]!.type).toBe('zoom')

    // center = (128 + 256/2, 72 + 144/2) = (256, 144) → (256/1280, 144/720) = (0.2, 0.2)
    const annPayload = JSON.parse(env.annotations[0]!.description!)
    expect(annPayload).toEqual({ x: 0.2, y: 0.2, level: 1.5 })

    expect(env.steps).toHaveLength(1)
    expect(env.steps[0]!.title.startsWith(ZOOM_TITLE_PREFIX)).toBe(true)
    const markerPayload = JSON.parse(env.steps[0]!.title.slice(ZOOM_TITLE_PREFIX.length))
    expect(markerPayload).toEqual({ x: 0.2, y: 0.2, level: 1.5 })
  })

  it('uses default level 1.5 when omitted', async () => {
    const locator = makeFakeLocator({ x: 0, y: 0, width: 100, height: 100 })

    await zoom(locator)

    const payload = JSON.parse(env.annotations[0]!.description!)
    expect(payload.level).toBe(1.5)
  })

  it('does nothing when boundingBox returns null', async () => {
    const locator = makeFakeLocator(null)

    await zoom(locator, 2)

    expect(env.annotations).toHaveLength(0)
    expect(env.steps).toHaveLength(0)
  })
})

describe('highlight() — marker contract', () => {
  let env: ReturnType<typeof makeFakeTest>

  beforeEach(() => {
    env = makeFakeTest()
    setupRecast(env.fakeTest)
  })

  it('pushes a highlight annotation and a marker step with the bounding box', async () => {
    const locator = makeFakeLocator({ x: 10, y: 20, width: 300, height: 50 })

    await highlight(locator, { color: '#FF0000', opacity: 0.6, duration: 2500 })

    expect(env.annotations).toHaveLength(1)
    expect(env.annotations[0]!.type).toBe('highlight')

    const annPayload = JSON.parse(env.annotations[0]!.description!)
    expect(annPayload).toMatchObject({
      x: 10, y: 20, width: 300, height: 50,
      color: '#FF0000', opacity: 0.6, duration: 2500,
    })

    expect(env.steps).toHaveLength(1)
    const markerPayload = JSON.parse(env.steps[0]!.title.slice(HIGHLIGHT_TITLE_PREFIX.length))
    expect(markerPayload).toEqual(annPayload)
  })

  it('does nothing when boundingBox returns null', async () => {
    const locator = makeFakeLocator(null)

    await highlight(locator)

    expect(env.annotations).toHaveLength(0)
    expect(env.steps).toHaveLength(0)
  })
})
