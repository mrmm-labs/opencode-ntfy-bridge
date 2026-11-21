import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { fakeNtfy } from "./connectors/fake-ntfy.test-util.ts"
import { fakeServer } from "./fake-server.test-util.ts"
import plugin from "./index.ts"
import { RPC_ID, type Snapshot } from "./rpc.ts"
import { startServer } from "./server.ts"

async function withEnv<T>(
  vars: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  )
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(prev))
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
}

async function setup() {
  const n = await fakeNtfy()
  const dir = await mkdtemp(join(tmpdir(), "oobb-server-"))
  const cfg = join(dir, "c.jsonc")
  await writeFile(
    cfg,
    JSON.stringify({
      channels: { ntfy: { server: n.url, topics: { out: "o", in: "i" } } },
    }),
  )
  const env = {
    OPENCODE_OOB_BRIDGE_CONFIG: cfg,
    OPENCODE_OOB_BRIDGE_DATA: dir,
  }
  return {
    n,
    dir,
    env,
    load: async () => {
      const server = fakeServer()
      const stop = await withEnv(env, () => startServer(server.ctx))
      return { server, stop }
    },
  }
}

const status = async (s: ReturnType<typeof fakeServer>, tui = "t") =>
  (
    (await s.call({
      method: "status",
      input: { tui, inputAt: Date.now() },
    })) as { output: Snapshot }
  ).output

describe("the server half", () => {
  it("is a server plugin that starts the bridge", () => {
    assert.equal(plugin.id, "oob-bridge")
    assert.equal(typeof plugin.setup, "function")
    assert.equal(RPC_ID, "oob-bridge")
  })

  it("does nothing without a config file", async () => {
    const server = fakeServer()
    const stop = await withEnv(
      { OPENCODE_OOB_BRIDGE_CONFIG: "/nonexistent/oob-bridge.jsonc" },
      () => startServer(server.ctx),
    )
    assert.equal(stop, undefined)
    assert.equal(server.registrations(), 0)
  })

  it("reports the owner, the channels and the windows through the RPC", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    assert.equal(server.registrations(), 1)
    const s = await status(server, "w1")
    assert.equal(s.owner.pid, process.pid)
    assert.equal(s.afk.tuis, 1)
    assert.equal(s.afk.away, false)
    assert.deepEqual(
      s.channels.map((c) => [c.id, c.enabled]),
      [["ntfy", true]],
    )
    assert.equal((await status(server, "w2")).afk.tuis, 2)
    await stop!()
    assert.equal(server.disposed(), 1)
    await t.n.close()
  })

  it("lets exactly one loader own the bridge: a second one stands by and takes over when the first stops", async () => {
    const t = await setup()
    const a = await t.load()
    const b = await t.load()
    assert.equal(a.server.registrations(), 1)
    assert.equal(b.server.registrations(), 0)
    // The standby has nothing to stop, and stopping it leaves the owner alone.
    await b.stop!()
    const c = await t.load()
    assert.equal(c.server.registrations(), 0)
    await c.stop!()
    assert.equal((await status(a.server)).owner.pid, process.pid)
    await a.stop!()
    const d = await t.load()
    assert.equal(d.server.registrations(), 1)
    await d.stop!()
    await t.n.close()
  })

  it("restarts the bridge without the server: the RPC keeps answering", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    const before = await status(server)
    const out = (
      (await server.call({
        method: "op",
        input: { op: "restart", args: {} },
      })) as { output: { ok: boolean } }
    ).output
    assert.equal(out.ok, true)
    const after = await status(server)
    assert.equal(after.owner.pid, before.owner.pid)
    assert.equal(server.registrations(), 1)
    assert.equal(server.disposed(), 0)
    await stop!()
    await t.n.close()
  })

  it("says why a form answer cannot be made when no window is attached", async () => {
    const t = await setup()
    const { server, stop } = await t.load()
    server.emit("form.created", {
      form: {
        id: "frm_1",
        sessionID: "root",
        metadata: { kind: "question" },
        fields: [{ key: "q0", type: "string", options: [{ label: "Yes" }] }],
      },
    })
    const pub = await t.n.waitFor(() => t.n.published[0])
    await t.n.waitFor(() => t.n.subscribes.length > 0)
    const body = (pub.body.actions as Array<{ body: string }>)[0].body
    t.n.send("r1", body)
    // No window to make the reply: the bridge answers in the channel and stays up.
    await t.n.waitFor(() => t.n.published[1])
    assert.equal(server.prompts.length, 0)
    assert.equal((await status(server)).owner.pid, process.pid)
    await stop!()
    await t.n.close()
  })
})
