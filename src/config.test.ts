import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  configPath,
  dataDir,
  loadConfig,
  parseConfig,
  type Config,
} from "./config.ts"

const base = {
  server: "https://ntfy.example/",
  topics: { out: "oc-x-out", in: "oc-x-in" },
}

describe("parseConfig", () => {
  it("fills defaults", () => {
    const c = parseConfig(base) as Config
    assert.equal(c.server, "https://ntfy.example")
    assert.equal(c.away.minutes, 10)
    assert.deepEqual(c.redact, { mode: "full" })
    assert.deepEqual(c.rules, [])
    assert.equal(c.token, undefined)
    assert.equal(c.actionAuth, true)
  })

  it("actionAuth is a boolean", () => {
    assert.equal(
      (parseConfig({ ...base, actionAuth: false }) as Config).actionAuth,
      false,
    )
    assert.ok("error" in parseConfig({ ...base, actionAuth: "yes" }))
  })

  it("accepts token from env or command and rules", () => {
    const c = parseConfig({
      ...base,
      token: { command: ["pass", "show", "ntfy"] },
      rules: [
        { agent: "^coordinator$" },
        { directory: "**/app" },
        { command: ["true"] },
      ],
      redact: "head:300",
      permissions: { tier: 3 },
    }) as Config
    assert.deepEqual(c.token, { command: ["pass", "show", "ntfy"] })
    assert.equal(c.rules.length, 3)
    assert.ok(c.rules[0].agent?.test("coordinator"))
    assert.deepEqual(
      (parseConfig({ ...base, token: { env: "T" } }) as Config).token,
      {
        env: "T",
      },
    )
  })

  it("refuses a literal token, tier 2 and bad topics", () => {
    assert.ok("error" in parseConfig({ ...base, token: "tk_abc" }))
    assert.ok("error" in parseConfig({ ...base, permissions: { tier: 2 } }))
    assert.ok(
      "error" in parseConfig({ ...base, topics: { out: "a", in: "a" } }),
    )
    assert.ok(
      "error" in parseConfig({ ...base, topics: { out: "a/b", in: "c" } }),
    )
    assert.ok("error" in parseConfig({ ...base, server: "ntfy.example" }))
    assert.ok("error" in parseConfig({ ...base, rules: [{}] }))
    assert.ok("error" in parseConfig({ ...base, redact: "half" }))
    assert.ok("error" in parseConfig({ ...base, away: { minutes: 0 } }))
  })
})

describe("loadConfig", () => {
  it("returns undefined when the file is missing (inert)", async () => {
    assert.equal(await loadConfig("/nonexistent/ntfy-bridge.jsonc"), undefined)
  })

  it("reads jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-cfg-"))
    const p = join(dir, "c.jsonc")
    await writeFile(p, `// c\n${JSON.stringify(base)}`)
    assert.equal(((await loadConfig(p)) as Config).topics.in, "oc-x-in")
    await writeFile(p, "{ nope")
    assert.ok("error" in ((await loadConfig(p)) as object))
  })

  it("accepts the shipped example", async () => {
    const example = join(import.meta.dirname, "..", "ntfy-bridge.example.jsonc")
    const c = (await loadConfig(example)) as Config
    assert.equal(c.topics.out, "oc-3k9f2x7q-out")
    assert.equal(c.rules.length, 2)
  })

  it("resolves paths from the environment", () => {
    assert.equal(
      configPath({ OPENCODE_NTFY_BRIDGE_CONFIG: "/x.jsonc" }),
      "/x.jsonc",
    )
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "/cfg" }),
      "/cfg/opencode/ntfy-bridge.jsonc",
    )
    assert.equal(dataDir({ XDG_DATA_HOME: "/d" }), "/d/opencode/ntfy-bridge")
    assert.equal(dataDir({ OPENCODE_NTFY_BRIDGE_DATA: "/e" }), "/e")
  })
})
