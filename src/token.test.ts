import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { filterSecrets } from "./filter.ts"
import { flushLog, log } from "./logger.ts"
import { resolveToken } from "./token.ts"

describe("resolveToken", () => {
  it("reads the environment", async () => {
    assert.equal(
      await resolveToken({ env: "T" }, { T: " abc-env-token \n" }),
      "abc-env-token",
    )
    assert.equal(await resolveToken({ env: "MISSING" }, {}), undefined)
    assert.equal(await resolveToken(undefined), undefined)
  })

  it("runs a command asynchronously and registers the value as a secret", async () => {
    const v = await resolveToken({ command: ["echo", "cmd-token-value-42"] })
    assert.equal(v, "cmd-token-value-42")
    assert.equal(filterSecrets("x cmd-token-value-42"), "x [redacted]")
  })

  it("rejects when the command fails", async () => {
    await assert.rejects(resolveToken({ command: ["false"] }))
  })

  it("AC-13: the token never reaches the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-log-"))
    const file = join(dir, "bridge.log")
    const prev = process.env.OPENCODE_NTFY_BRIDGE_LOG
    process.env.OPENCODE_NTFY_BRIDGE_LOG = file
    try {
      const v = await resolveToken(
        { env: "T" },
        { T: "env-token-should-not-leak" },
      )
      log("probe", { header: `Bearer ${v}`, raw: v })
      await flushLog()
      const text = await readFile(file, "utf8")
      assert.match(text, /probe/)
      assert.doesNotMatch(text, /env-token-should-not-leak/)
    } finally {
      process.env.OPENCODE_NTFY_BRIDGE_LOG = prev
    }
  })
})
