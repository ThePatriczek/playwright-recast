export type CameraPose = { x: number; y: number; zoom: number }
export type CameraKeyframe = CameraPose & { atMs: number }
export type FocusRegion = { x: number; y: number; width: number; height: number; label: string }
export const overview: CameraPose = { x: 0.5, y: 0.5, zoom: 1 }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

export function constrainPose(pose: CameraPose): CameraPose {
  const zoom = clamp(pose.zoom, 1, 1.7)
  const half = 0.5 / zoom
  return { x: clamp(pose.x, half, 1 - half), y: clamp(pose.y, half, 1 - half), zoom }
}

export function cropFor(pose: CameraPose): { left: number; top: number; width: number; height: number } {
  const size = 1 / pose.zoom
  return { left: pose.x - size / 2, top: pose.y - size / 2, width: size, height: size }
}

export function focusInShot(pose: CameraPose, focus: FocusRegion): { x: number; y: number; visibleFraction: number } {
  const crop = cropFor(pose)
  const width = Math.max(0, Math.min(crop.left + crop.width, focus.x + focus.width) - Math.max(crop.left, focus.x))
  const height = Math.max(0, Math.min(crop.top + crop.height, focus.y + focus.height) - Math.max(crop.top, focus.y))
  return {
    x: (focus.x + focus.width / 2 - crop.left) / crop.width,
    y: (focus.y + focus.height / 2 - crop.top) / crop.height,
    visibleFraction: width * height / Math.max(0.000001, focus.width * focus.height),
  }
}

export function poseAt(keyframes: CameraKeyframe[], atMs: number): CameraPose {
  if (!keyframes.length) return { ...overview }
  if (atMs <= keyframes[0].atMs) return { ...keyframes[0] }
  for (let index = 1; index < keyframes.length; index++) {
    const previous = keyframes[index - 1]
    const next = keyframes[index]
    if (atMs > next.atMs) continue
    const t = clamp((atMs - previous.atMs) / (next.atMs - previous.atMs), 0, 1)
    const ease = t * t * (3 - 2 * t)
    return {
      x: previous.x + (next.x - previous.x) * ease,
      y: previous.y + (next.y - previous.y) * ease,
      zoom: previous.zoom + (next.zoom - previous.zoom) * ease,
    }
  }
  return { ...keyframes[keyframes.length - 1] }
}

export function validatePath(keyframes: CameraKeyframe[]): void {
  if (!keyframes.length || keyframes[0].atMs !== 0) throw new Error('Camera path must begin at zero')
  for (let index = 0; index < keyframes.length; index++) {
    const point = keyframes[index]
    if (![point.atMs, point.x, point.y, point.zoom].every(Number.isFinite)) throw new Error('Camera path contains a nonfinite value')
    if (index > 0 && point.atMs <= keyframes[index - 1].atMs) throw new Error('Camera times must strictly increase')
    const valid = constrainPose(point)
    if (Math.abs(point.x - valid.x) + Math.abs(point.y - valid.y) + Math.abs(point.zoom - valid.zoom) > 0.00001) throw new Error('Camera crop leaves the source frame')
  }
}

export function buildCameraFilter(keyframes: CameraKeyframe[], width: number, height: number, fps = 60): string {
  validatePath(keyframes)
  const expression = (property: keyof CameraPose, register: number) => {
    const parts = [keyframes[0][property].toFixed(8)]
    for (let index = 1; index < keyframes.length; index++) {
      const previous = keyframes[index - 1]
      const next = keyframes[index]
      const delta = next[property] - previous[property]
      if (Math.abs(delta) < 0.00000001) continue
      const start = (previous.atMs / 1000).toFixed(6)
      const duration = ((next.atMs - previous.atMs) / 1000).toFixed(6)
      parts.push(`(${delta.toFixed(8)})*(st(${register},clip((in/${fps}-${start})/${duration},0,1))*ld(${register})*(3-2*ld(${register})))`)
    }
    return parts.join('+')
  }
  const zoom = expression('zoom', 0)
  const x = `max(0,min(iw-iw/zoom,(${expression('x', 1)})*iw-iw/(2*zoom)))`
  const y = `max(0,min(ih-ih/zoom,(${expression('y', 2)})*ih-ih/(2*zoom)))`
  return `fps=${fps},scale=${width * 2}:${height * 2}:flags=lanczos,zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`
}
