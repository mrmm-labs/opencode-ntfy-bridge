/**
 * QR code as terminal text, two modules per character row with half blocks.
 *
 * Light modules are the filled glyphs, so on the usual light-on-dark terminal
 * the code looks like a white tile with dark modules; phone cameras read it.
 */
import qrcode from "qrcode-generator"

/** Modules of empty border on each side; the QR standard asks for 4. */
export const QUIET = 4

export type Qr = { lines: string[]; width: number; height: number }

const GLYPH = [" ", "▄", "▀", "█"] as const

/** Encodes `text` (error correction L, smallest version) as lines of ▀▄█ and spaces. */
export function renderQr(text: string, quiet = QUIET): Qr {
  const qr = qrcode(0, "L")
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const size = n + 2 * quiet
  const light = (r: number, c: number) => {
    const y = r - quiet
    const x = c - quiet
    return y < 0 || x < 0 || y >= n || x >= n || !qr.isDark(y, x)
  }
  const lines: string[] = []
  for (let r = 0; r < size; r += 2) {
    let line = ""
    for (let c = 0; c < size; c++)
      line += GLYPH[(light(r, c) ? 2 : 0) + (light(r + 1, c) ? 1 : 0)]
    lines.push(line)
  }
  return { lines, width: size, height: lines.length }
}
