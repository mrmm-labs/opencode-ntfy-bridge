import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
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
    assert.equal(await loadConfig("/nonexistent/oob-bridge.jsonc"), undefined)
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
    const example = join(import.meta.dirname, "..", "oob-bridge.example.jsonc")
    const c = (await loadConfig(example)) as Config
    assert.equal(c.topics.out, "oc-3k9f2x7q-out")
    assert.equal(c.rules.length, 2)
  })

  it("resolves paths from the environment", () => {
    assert.equal(
      configPath({ OPENCODE_OOB_BRIDGE_CONFIG: "/x.jsonc" }),
      "/x.jsonc",
    )
    assert.equal(
      configPath({ XDG_CONFIG_HOME: "/cfg" }),
      "/cfg/opencode/oob-bridge.jsonc",
    )
    assert.equal(dataDir({ XDG_DATA_HOME: "/d" }), "/d/opencode/oob-bridge")
    assert.equal(dataDir({ OPENCODE_OOB_BRIDGE_DATA: "/e" }), "/e")
  })

  it("falls back to the pre-rename names", async () => {
    assert.equal(
      configPath({ OPENCODE_NTFY_BRIDGE_CONFIG: "/o.jsonc" }),
      "/o.jsonc",
    )
    assert.equal(dataDir({ OPENCODE_NTFY_BRIDGE_DATA: "/o" }), "/o")
    const base = await mkdtemp(join(tmpdir(), "oobb-legacy-"))
    await mkdir(join(base, "opencode"))
    await writeFile(
      join(base, "opencode", "ntfy-bridge.jsonc"),
      JSON.stringify({
        server: "https://n.example",
        topics: { out: "a", in: "b" },
      }),
    )
    const keys = ["XDG_CONFIG_HOME", "OPENCODE_OOB_BRIDGE_CONFIG"] as const
    const prev = keys.map((k) => process.env[k])
    process.env.XDG_CONFIG_HOME = base
    delete process.env.OPENCODE_OOB_BRIDGE_CONFIG
    try {
      assert.equal(((await loadConfig()) as Config).server, "https://n.example")
      assert.equal(await loadConfig(join(base, "other.jsonc")), undefined)
    } finally {
      keys.forEach((k, i) =>
        prev[i] === undefined
          ? delete process.env[k]
          : (process.env[k] = prev[i]),
      )
    }
  })
})
