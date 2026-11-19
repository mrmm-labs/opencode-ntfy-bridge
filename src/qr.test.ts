import assert from "node:assert/strict"
import { describe, it } from "node:test"

import qrcode from "qrcode-generator"

import { QUIET, renderQr } from "./qr.ts"

const HELLO = [
  "█████████████████████████████",
  "█████████████████████████████",
  "████ ▄▄▄▄▄ █ ▄ ▄ █ ▄▄▄▄▄ ████",
  "████ █   █ █ ▀▀▀██ █   █ ████",
  "████ █▄▄▄█ █▀▀█▀▄█ █▄▄▄█ ████",
  "████▄▄▄▄▄▄▄█▄▀ ▀ █▄▄▄▄▄▄▄████",
  "████ ▄▀█▄ ▄██ █ ▀██ █    ████",
  "████▀██▄█▄▄▀ ▄▄▄█▀ ▄ ██▄█████",
  "████▄▄▄█▄▄▄▄▀▄██   ██▀▄ ▀████",
  "████ ▄▄▄▄▄ █▀ █▀ ▄█▀█▄█ █████",
  "████ █   █ █▄▀  ▀█▄▄▄▀▄▀ ████",
  "████ █▄▄▄█ █▀▀ ▄█▀ ▄▄▄███████",
  "████▄▄▄▄▄▄▄█▄▄▄█▄▄▄▄▄█▄█▄████",
  "█████████████████████████████",
  "█████████████████████████████",
]

/** Reads the text back into a grid: true is a dark module. */
function decode(lines: string[]): boolean[][] {
  const rows: boolean[][] = []
  for (const line of lines) {
    const top: boolean[] = []
    const bottom: boolean[] = []
    for (const ch of line) {
      top.push(ch === " " || ch === "▄")
      bottom.push(ch === " " || ch === "▀")
    }
    rows.push(top, bottom)
  }
  return rows
}

describe("renderQr", () => {
  it("renders a fixed input to stable text", () => {
    assert.deepEqual(renderQr("HELLO").lines, HELLO)
  })

  it("is size + 2 quiet modules wide and half as many rows tall", () => {
    const q = renderQr("HELLO")
    const n = 21
    assert.equal(q.width, n + 2 * QUIET)
    assert.equal(q.height, Math.ceil((n + 2 * QUIET) / 2))
    assert.ok(q.lines.every((l) => [...l].length === q.width))
    const link = renderQr("https://t.me/oob_test_bot?start=ABCD23")
    assert.equal(link.width, 37)
    assert.equal(link.height, 19)
  })

  it("leaves a light quiet zone on every side and keeps every module", () => {
    const text = "https://t.me/oob_test_bot?start=ABCD23"
    const q = renderQr(text)
    const grid = decode(q.lines)
    const ref = qrcode(0, "L")
    ref.addData(text)
    ref.make()
    const n = ref.getModuleCount()
    for (let r = 0; r < grid.length; r++)
      for (let c = 0; c < q.width; c++) {
        const y = r - QUIET
        const x = c - QUIET
        const inside = y >= 0 && x >= 0 && y < n && x < n
        assert.equal(grid[r][c], inside && ref.isDark(y, x), `module ${r},${c}`)
      }
  })

  it("starts each finder pattern with a dark 7-module row", () => {
    const grid = decode(renderQr("HELLO").lines)
    const row = grid[QUIET].slice(QUIET, QUIET + 7)
    assert.deepEqual(row, Array(7).fill(true))
  })
})
