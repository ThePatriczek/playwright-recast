import type { SubtitleEntry } from '../types/subtitle.js'
import type { SubtitleStyle } from '../types/render.js'

/** Video resolution for ASS coordinate space */
export interface AssResolution {
  width: number
  height: number
}

/**
 * Convert '#RRGGBB' hex color to ASS color format '&HAABBGGRR'.
 * ASS uses reversed byte order (BGR) and alpha where 00=opaque, FF=transparent.
 */
export function hexToAss(hex: string, opacity: number = 1.0): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2).toUpperCase()
  const g = clean.slice(2, 4).toUpperCase()
  const b = clean.slice(4, 6).toUpperCase()
  const alpha = Math.round((1.0 - Math.max(0, Math.min(1, opacity))) * 255)
  const alphaHex = alpha.toString(16).padStart(2, '0').toUpperCase()
  return `&H${alphaHex}${b}${g}${r}`
}

/** Format milliseconds as ASS time: H:MM:SS.CC (centiseconds) */
function formatAssTime(ms: number): string {
  const rounded = Math.max(0, Math.round(ms))
  const h = Math.floor(rounded / 3600000)
  const m = Math.floor((rounded % 3600000) / 60000)
  const s = Math.floor((rounded % 60000) / 1000)
  const cs = Math.floor((rounded % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function resolveWrapStyle(ws?: SubtitleStyle['wrapStyle']): number {
  switch (ws) {
    case 'endOfLine': return 1
    case 'none': return 2
    case 'smart':
    default: return 0
  }
}

/**
 * Write subtitle entries to ASS (Advanced SubStation Alpha) format
 * with configurable styling — background box, font, colors, positioning.
 */
export function writeAss(
  entries: SubtitleEntry[],
  style: SubtitleStyle = {},
  resolution: AssResolution = { width: 1920, height: 1080 },
): string {
  if (entries.length === 0) return ''

  // Resolve style with defaults
  const fontFamily = style.fontFamily ?? 'Arial'
  const fontSize = style.fontSize ?? 52
  const primaryColor = style.primaryColor ?? style.color ?? '#1a1a1a'
  const bgColor = style.backgroundColor ?? '#FFFFFF'
  const bgOpacity = style.backgroundOpacity ?? 0.75
  const padding = style.padding ?? 18
  const shadow = style.shadow ?? 0
  const position = style.position ?? 'bottom'
  const marginV = style.marginVertical ?? style.marginBottom ?? 50
  const marginH = style.marginHorizontal ?? 80
  const bold = style.bold !== false ? -1 : 0 // ASS: -1 = bold, 0 = normal
  const wrapStyle = resolveWrapStyle(style.wrapStyle)

  // ASS alignment: bottom-center=2, top-center=8
  const alignment = position === 'top' ? 8 : 2

  // Convert colors to ASS format
  const assPrimary = hexToAss(primaryColor, 1.0)
  const assSecondary = hexToAss('#000000', 0.0) // unused
  // OutlineColour = same as BackColour so outline acts as padding extension
  const assOutline = hexToAss(bgColor, bgOpacity)
  const assBack = hexToAss(bgColor, bgOpacity)

  // Build style line
  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour,
  //         OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,
  //         ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow,
  //         Alignment, MarginL, MarginR, MarginV, Encoding
  const styleLine = [
    'Default',
    fontFamily,
    fontSize,
    assPrimary,
    assSecondary,
    assOutline,
    assBack,
    bold,     // Bold
    0,        // Italic
    0,        // Underline
    0,        // StrikeOut
    100,      // ScaleX
    100,      // ScaleY
    0,        // Spacing
    0,        // Angle
    3,        // BorderStyle (3 = opaque box)
    padding,  // Outline (acts as box padding in BorderStyle=3)
    shadow,   // Shadow
    alignment,
    marginH,  // MarginL
    marginH,  // MarginR
    marginV,  // MarginV
    1,        // Encoding (1 = default)
  ].join(',')

  // Build dialogue lines
  const dialogues = entries.map((entry) => {
    const start = formatAssTime(entry.startMs)
    const end = formatAssTime(entry.endMs)
    // Escape special ASS characters and convert newlines
    const text = entry.text
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N')
    return `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${resolution.width}`,
    `PlayResY: ${resolution.height}`,
    `WrapStyle: ${wrapStyle}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleLine}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogues,
    '', // trailing newline
  ].join('\n')
}
