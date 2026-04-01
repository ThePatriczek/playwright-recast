import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CursorOverlayConfig } from '../types/cursor-overlay.js'

export const DEFAULT_CURSOR_OVERLAY = {
  size: 24,
  color: '#FFFFFF',
  opacity: 0.9,
  easing: 'ease-in-out' as const,
  hideAfterMs: 500,
  shadow: true,
} as const

export type ResolvedCursorOverlayConfig = Required<
  Pick<CursorOverlayConfig, 'size' | 'color' | 'opacity' | 'easing' | 'hideAfterMs' | 'shadow'>
> & CursorOverlayConfig

/** Merge user config with defaults */
export function resolveCursorOverlayConfig(
  config: CursorOverlayConfig,
): ResolvedCursorOverlayConfig {
  return {
    ...config,
    size: config.size ?? DEFAULT_CURSOR_OVERLAY.size,
    color: config.color ?? DEFAULT_CURSOR_OVERLAY.color,
    opacity: config.opacity ?? DEFAULT_CURSOR_OVERLAY.opacity,
    easing: config.easing ?? DEFAULT_CURSOR_OVERLAY.easing,
    hideAfterMs: config.hideAfterMs ?? DEFAULT_CURSOR_OVERLAY.hideAfterMs,
    shadow: config.shadow ?? DEFAULT_CURSOR_OVERLAY.shadow,
  }
}

/**
 * Write the bundled default cursor image to a temp file.
 * Standard arrow cursor (60x87 PNG with transparency) stored as base64.
 */
export function writeDefaultCursorImage(tmpDir: string): string {
  const outputPath = path.join(tmpDir, 'cursor.png')
  if (fs.existsSync(outputPath)) return outputPath

  const data = Buffer.from(DEFAULT_CURSOR_PNG_BASE64, 'base64')
  fs.writeFileSync(outputPath, data)
  return outputPath
}

// Default arrow cursor — 30x44 RGBA PNG, 72 DPI (~1.3KB)
// Re-encoded at 72 DPI for ffmpeg 7.x compatibility (288 DPI causes inflate errors)
/* eslint-disable max-len */
const DEFAULT_CURSOR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAB4AAAAsCAYAAABygggEAAAACXBIWXMAAAABAAAAAQBPJcTWAAAFBUlEQVR4nL2YW0hjRxjHT4zJrmvTdE2rXd01XV0tCopSKiFeUiwtwrKtlD5UqVUoQl0VBOulxgte0nqpWyyiFfEKyopX8E3fRF9k+yKloCDoQ7VQzW4VtYrp9PsmM2fPMZvE3DrwN+fMOWd++eb8v28mCoK9KfBPWlpajEajuSHtC3SjkI6ODsvy8nLP1f5AQpV40NDQ8IPNZiNTU1Ot/wccBw7Gg/r6egpGTUxMNEuuBwQeBFLjAUTcycGosbGx7wIJRzAaSgngHxG4s7NDzs/PKXx4eLgmUHAE3wSpAPwEYe3t7aSiokKMfGho6NtAwDlYDeCfOBjOSWNjowgfGBgo9zfcAdzZ2UnBKIvFwuG2/v7+x/6EuwSjcAY4vLe39xvJcz7B3YJR2Mfglz09PV/7A34tMAqAHH7e3d39la/wa4NRfX19Iryrq+tLX+AegVFgMg7/B+p7nrdwj8GowcFBDj8B53/Gxgo8OCgoiIyPj3P4cWtra66ncK/AHA6LCYcfNTc3f+IJ3GswSqlUksnJSQ7/22w250jGDRwYpVKpyOzsLIcf1tXVfXQduM9gVEhICFlYWODwg+rq6g/dwf0C5vDFxUUO/6uystLkCu43sMAMNz8/z+F7sLwancG9AqvVapKcnOyg+Ph4YjKZyObmJof/UV5ebngV3CswTuv6+jod/PT0lJydnVHhzuX4+JicnJyIaznoz7KyMofI3YJx+lpaWkhUVJSsv6qqig58eXmJwOfw+QIFfajnTFZMM9Cz/Pz8B4ypcAtWKBRieSwpKZGBo6OjycHBAV2nm5qa6pOSkh4aDIZPQY+MRuPD9PT0jzMyMj6AqTfk5OS8HxcXFylIarpTMEYKmz1xylZXV2mfFA77MXptenr6KZzHguJBD9jxO6Ao0JugUMG+qQx2Cm5ra6ODjo6Ocui/FxcXpzil2dnZMnBWVha9B96vNSUlxchAKIzubdBboNug1xhY6RSMay5s7sRIoRJ9D0vhMB6PjIzIwPgqVlZW6H2wPpsZ4A3Q6yANO7/FoCqXU310dCRGCqbqgGsJmZmZn+P6e3h4SPR6vQxeXFxM79/f3/81PDwcIwwR7D8SVEzBLFLZmu0AlkAt0P8uKBEiS1xbW1vGazU1NTKwTqcju7u79LnS0tJHbFw+pVLJmgiG305PJNAm6IthJrkPuguRleD1jY0NmsdSOOzBuAEnJRG6XB45OBg28D8zc9XBuR4UzQwSDroD05i4t7e3iffk5ubKwGAsWkAwh8GAiWxct6sTtTkALWCiFga7K9gdyU2iw3PYabYjeG5uzqGazczMEGZA85XpdgpGI4TGxsbeh4U9Ao4jGIinwA0OT01NzYDUeoElMSEhQdwMYJphniMYisrvkZGREe7A/PcxOhGTXMuivMW+kJIJX0cYTvnS0tI0AnCfXVBQQMB00rpMdyKFhYXpbGyn083/I6Bikd0UXuacUvKwmn0hXV5e3hc2e5MBrVbrPmwAf4HyaIIKd5uN4/I988GVwqtzjn85nAUdODpma2vrGQdub2//hqkHryoTrt8T7N7QXgfMB3eac8JLE+KAYbW1tZWQVktFRUWPtVrte4I97TD90JS8NvNK5VPjXsABdVBQ7sF0IkjPoPiJ2YA+cKjLvjYeNU8vdO4dwZ7nYawfTSr1h1/A/F0jPJSBNOyY12eHmuyvJjWhy0UgEO2qET2G/Qf1BIKcbuFFzwAAAABJRU5ErkJggg=='
