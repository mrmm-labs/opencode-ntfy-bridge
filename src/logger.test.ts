import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { flushLog, log, logTarget } from "./logger.ts"

describe("logger in a test run", () => {
  it("refuses the default log path, and writes to one the test chose", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-log-"))
    const keep = { ...process.env }
    try {
      delete process.env.OPENCODE_OOB_BRIDGE_LOG
      delete process.env.OPENCODE_OOB_BRIDGE_DATA
      delete process.env.OPENCODE_NTFY_BRIDGE_LOG
      delete process.env.OPENCODE_NTFY_BRIDGE_DATA
      process.env.XDG_DATA_HOME = dir
      assert.ok(process.env.NODE_TEST_CONTEXT, "runs under node --test")
      assert.equal(logTarget(), undefined)
      log("should_not_land")
      await flushLog()
      await assert.rejects(stat(join(dir, "opencode")))

      process.env.OPENCODE_OOB_BRIDGE_DATA = join(dir, "data")
      assert.equal(logTarget(), join(dir, "data", "bridge.log"))
      log("lands")
      await flushLog()
      assert.match(
        await readFile(join(dir, "data", "bridge.log"), "utf8"),
        /lands/,
      )
    } finally {
      for (const k of Object.keys(process.env))
        if (!(k in keep)) delete process.env[k]
      Object.assign(process.env, keep)
    }
  })

  it("outside a test run the default path is used", () => {
    assert.match(
      logTarget({ XDG_DATA_HOME: "/x" })!,
      /\/x\/opencode\/oob-bridge\/bridge\.log$/,
    )
    assert.equal(
      logTarget({ NODE_TEST_CONTEXT: "child", XDG_DATA_HOME: "/x" }),
      undefined,
    )
    assert.equal(
      logTarget({
        NODE_TEST_CONTEXT: "child",
        OPENCODE_OOB_BRIDGE_LOG: "/dev/null",
      }),
      "/dev/null",
    )
  })
})
