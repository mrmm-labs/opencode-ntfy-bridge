import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseJsonc } from "./jsonc.ts"

describe("parseJsonc", () => {
  it("strips line and block comments and trailing commas", () => {
    const text = `{
      // a comment
      "a": 1, /* inline */
      "list": [1, 2,],
      "nested": { "b": 2, },
    }`
    assert.deepEqual(parseJsonc(text), { a: 1, list: [1, 2], nested: { b: 2 } })
  })

  it("leaves comment markers, commas and escapes inside strings alone", () => {
    const text = `{ "url": "http://x//y", "re": "(?i)\\\\b(a|b)\\\\b,]", "q": "say \\"hi\\" /* no */" }`
    assert.deepEqual(parseJsonc(text), {
      url: "http://x//y",
      re: "(?i)\\b(a|b)\\b,]",
      q: 'say "hi" /* no */',
    })
  })

  it("throws on invalid json", () => {
    assert.throws(() => parseJsonc("{ nope"))
  })
})
