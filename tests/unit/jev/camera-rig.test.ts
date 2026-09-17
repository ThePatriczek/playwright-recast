import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { applyCommand, availableCommands, buildCameraFilter, constrainPose, cropFor, focusInShot, overview, poseAt, stabilizeCommand, validatePath } from '../../../demo/jev/camera-rig.js'

describe('camera motion', () => {
  it('keeps every crop inside the source even after repeated directional commands', () => {
    let pose = overview
    for (const command of ['zoomIn', 'zoomIn', 'zoomIn', 'zoomIn', 'moveLeft', 'moveLeft', 'moveLeft', 'moveUp', 'moveUp', 'zoomOut', 'zoomOut'] as const) {
      pose = applyCommand(pose, command)
      const crop = cropFor(pose)
      expect(crop.left).toBeGreaterThanOrEqual(-0.000001)
      expect(crop.top).toBeGreaterThanOrEqual(-0.000001)
      expect(crop.left + crop.width).toBeLessThanOrEqual(1.000001)
      expect(crop.top + crop.height).toBeLessThanOrEqual(1.000001)
    }
  })

  it('does not offer invisible pans at full-frame zoom', () => {
    expect(Object.keys(availableCommands(overview))).toEqual(['zoomIn', 'hold'])
  })

  it('stays still when a weak movement barely wins over staying', () => {
    const proposal = { choice: 'zoomIn', confidence: 0.17, probabilities: { zoomIn: 0.58, hold: 0.42 } }
    const focus = { x: 0.4, y: 0.4, width: 0.2, height: 0.1, label: 'Name' }
    expect(stabilizeCommand(proposal, overview, focus, 3000, 0).command).toBe('hold')
  })

  it('allows a settled shot to be read before accepting another movement', () => {
    const proposal = { choice: 'zoomIn', confidence: 0.95, probabilities: { zoomIn: 0.95, hold: 0.05 } }
    const focus = { x: 0.4, y: 0.4, width: 0.1, height: 0.05, label: 'Name' }
    expect(stabilizeCommand(proposal, { x: 0.5, y: 0.5, zoom: 1.18 }, focus, 3000, 2500)).toEqual({ command: 'hold', reason: 'settling' })
  })

  it('accepts a confident correction when the subject is outside the shot', () => {
    const proposal = { choice: 'moveRight', confidence: 0.95, probabilities: { moveRight: 0.95, hold: 0.05 } }
    const focus = { x: 0.9, y: 0.4, width: 0.08, height: 0.05, label: 'Save' }
    expect(stabilizeCommand(proposal, { x: 0.4, y: 0.5, zoom: 1.5 }, focus, 3000, 2500).command).toBe('moveRight')
  })

  it('reports when the focal target has left the crop', () => {
    const focus = { x: 0.9, y: 0.1, width: 0.08, height: 0.05, label: 'Save' }
    expect(focusInShot(overview, focus).visibleFraction).toBeCloseTo(1)
    expect(focusInShot(constrainPose({ x: 0.3, y: 0.5, zoom: 1.7 }), focus).visibleFraction).toBe(0)
  })

  it('holds a pose across a pause and approaches a new pose continuously', () => {
    const path = [
      { atMs: 0, ...overview },
      { atMs: 1000, ...overview },
      { atMs: 2000, x: 0.6, y: 0.5, zoom: 1.5 },
      { atMs: 3000, x: 0.6, y: 0.5, zoom: 1.5 },
    ]
    expect(poseAt(path, 500).zoom).toBe(1)
    expect(poseAt(path, 1500).zoom).toBeCloseTo(1.25)
    expect(poseAt(path, 2500).x).toBeCloseTo(0.6)
    expect(poseAt(path, 2000).x - poseAt(path, 1999).x).toBeLessThan(0.000001)
  })

  it('rejects backward time and out-of-frame endpoints before rendering', () => {
    expect(() => validatePath([{ atMs: 0, ...overview }, { atMs: 0, ...overview }])).toThrow('strictly increase')
    expect(() => validatePath([{ atMs: 0, ...overview }, { atMs: 1000, x: 0, y: 0, zoom: 1 }])).toThrow('leaves the source frame')
  })

  it('renders a rightward crop at the requested source coordinates', () => {
    const filter = buildCameraFilter([{ atMs: 0, x: 0.7, y: 0.5, zoom: 1.7 }], 320, 180, 30)
    const frame = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=0.1,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill', '-vf', filter, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    const left = (90 * 320 + 25) * 3
    const right = (90 * 320 + 200) * 3
    expect(frame[left]).toBeGreaterThan(200)
    expect(frame[left + 2]).toBeLessThan(30)
    expect(frame[right]).toBeLessThan(30)
    expect(frame[right + 2]).toBeGreaterThan(200)
  })
})
