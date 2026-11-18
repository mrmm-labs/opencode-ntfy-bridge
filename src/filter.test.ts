import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { filterSecrets, parseRedact, redact, registerSecret } from "./filter.ts"

describe("filterSecrets", () => {
  it("masks common secret shapes", () => {
    const cases = [
      "key sk-abcdefghijklmnop1234",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abcdef",
      "AKIAABCDEFGHIJKLMNOP",
      "tk_abcdefghijklmnopqrstuvwxyz012",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ]
    for (const c of cases) assert.match(filterSecrets(c), /\[redacted\]/, c)
    assert.doesNotMatch(filterSecrets(cases[0]), /abcdefghijklmnop1234/)
  })

  it("keeps the key name of key=value pairs and the auth scheme", () => {
    assert.equal(filterSecrets("password=hunter22"), "password=[redacted]")
    assert.equal(
      filterSecrets('"api_key": "abcd1234"'),
      '"api_key": "[redacted]"',
    )
    assert.equal(
      filterSecrets("Authorization: Bearer abc.def.ghi123"),
      "Authorization: Bearer [redacted]",
    )
    assert.equal(
      filterSecrets("postgres://app:s3cret@db:5432/x"),
      "postgres://app:[redacted]@db:5432/x",
    )
  })

  it("masks registered values anywhere", () => {
    registerSecret("plain-looking-value")
    assert.equal(filterSecrets("x plain-looking-value y"), "x [redacted] y")
  })

  it("leaves ordinary text alone", () => {
    const t = "Should I run the migration on staging? Options: yes / no"
    assert.equal(filterSecrets(t), t)
  })
})

describe("redact", () => {
  it("applies full, head and title modes after filtering", () => {
    assert.equal(redact("abc", { mode: "full" }), "abc")
    assert.equal(redact("abcdef", { mode: "head", n: 3 }), "abc…")
    assert.equal(redact("abc", { mode: "head", n: 3 }), "abc")
    assert.doesNotMatch(redact("secret", { mode: "title" }), /secret/)
    assert.equal(
      redact("token=abcdef", { mode: "head", n: 100 }),
      "token=[redacted]",
    )
  })

  it("parses the redact setting", () => {
    assert.deepEqual(parseRedact(undefined), { mode: "full" })
    assert.deepEqual(parseRedact("head:300"), { mode: "head", n: 300 })
    assert.deepEqual(parseRedact("title"), { mode: "title" })
    assert.equal(parseRedact("head:0"), undefined)
    assert.equal(parseRedact("half"), undefined)
  })
})
