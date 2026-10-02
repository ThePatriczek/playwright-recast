/**
 * Pixel size of a JPEG, from its start-of-frame header. In Chromium the
 * trace's screencast frames are the frames the page videos record, at the
 * size Playwright recorded them, so this is a page's content box in its video.
 */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  if (data[0] !== 0xff || data[1] !== 0xd8) return undefined
  let i = 2
  while (i + 1 < data.length) {
    if (data[i] !== 0xff) { i++; continue }
    const marker = data[i + 1]!
    // Fill bytes (T.81 B.1.1.2) precede a marker
    if (marker === 0xff) { i++; continue }
    // SOF precedes the scan: past SOS or at EOI there is no size, only entropy data
    if (marker === 0xda || marker === 0xd9) return undefined
    // Markers without a length: TEM, RST0-7, SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue }
    if (i + 3 >= data.length) return undefined
    const length = data.readUInt16BE(i + 2)
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= data.length) return undefined
      const width = data.readUInt16BE(i + 7)
      const height = data.readUInt16BE(i + 5)
      // Height 0 is defined later by a DNL marker: not a size to crop to
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    i += 2 + length
  }
  return undefined
}
