import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { fakeNtfy } from "./fake-ntfy.test-util.ts"
import plugin, { setup } from "./tui.ts"

type Handler = (e: unknown) => void

function fakeCtx() {
  const handlers = new Map<string, Handler>()
  const replies: unknown[] = []
  const toasts: string[] = []
  const commands: Array<{
    slash?: { name: string }
    run: (i?: string) => unknown
  }> = []
  const sessions: Record<string, Record<string, unknown>> = {
    root: {
      id: "root",
      agent: "coordinator",
      location: { directory: "/w/shop" },
      title: "T",
    },
  }
  const ctx = {
    data: {
      on: (type: string, h: Handler) => {
        handlers.set(type, h)
        return () => handlers.delete(type)
      },
      session: {
        get: (id: string) => sessions[id],
        root: (id: string) => id,
        form: {
          reply: async (input: unknown) => {
            replies.push(input)
          },
        },
      },
    },
    client: { session: { get: async () => undefined } },
    keymap: {
      layer: (f: () => { commands: typeof commands }) =>
        commands.push(...f().commands),
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "root" }) },
      toast: { show: (o: { message: string }) => toasts.push(o.message) },
    },
  }
  return { ctx: ctx as never, handlers, replies, toasts, commands }
}

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

describe("TUI entry", () => {
  it("exports an OpenCode 2 TUI plugin", () => {
    assert.equal(plugin.id, "ntfy-bridge.tui")
    assert.equal(typeof plugin.setup, "function")
  })

  it("AC-14: without config it registers nothing and makes no request", async () => {
    const f = fakeCtx()
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("no network expected")
    }) as typeof fetch
    try {
      const cleanup = await withEnv(
        { OPENCODE_NTFY_BRIDGE_CONFIG: "/nonexistent/ntfy-bridge.jsonc" },
        () => setup(f.ctx),
      )
      assert.equal(cleanup, undefined)
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(calls, 0)
    assert.equal(f.handlers.size, 0)
    assert.equal(f.commands.length, 0)
  })

  it("stays inert on an invalid config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-tui-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(cfg, JSON.stringify({ server: "x", token: "literal" }))
    const f = fakeCtx()
    const cleanup = await withEnv({ OPENCODE_NTFY_BRIDGE_CONFIG: cfg }, () =>
      setup(f.ctx),
    )
    assert.equal(cleanup, undefined)
    assert.equal(f.handlers.size, 0)
  })

  it("wires events, /ntfy and form replies end to end against a fake ntfy", async () => {
    const n = await fakeNtfy()
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-tui-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(
      cfg,
      JSON.stringify({
        server: n.url,
        topics: { out: "oc-out", in: "oc-in" },
        token: { env: "NTFYB_T" },
      }),
    )
    const f = fakeCtx()
    const cleanup = await withEnv(
      {
        OPENCODE_NTFY_BRIDGE_CONFIG: cfg,
        OPENCODE_NTFY_BRIDGE_DATA: dir,
        NTFYB_T: "tk_test_token_abcdefghijklmnop",
      },
      () => setup(f.ctx),
    )
    assert.ok(cleanup)
    assert.ok(f.handlers.has("form.created"))
    const cmd = f.commands.find((c) => c.slash?.name === "ntfy")!
    cmd.run("on")
    assert.equal(f.toasts.at(-1), "ntfy routing: on")
    cmd.run("bogus")
    assert.match(f.toasts.at(-1)!, /Usage/)

    f.handlers.get("form.created")!({
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "root",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              type: "string",
              description: "Go?",
              options: [{ label: "Yes" }, { label: "No" }],
            },
          ],
        },
      },
    })
    const pub = await n.waitFor(() => n.published[0])
    assert.equal(pub.auth, "Bearer tk_test_token_abcdefghijklmnop")
    assert.equal(pub.body.title, "shop · coordinator asks")
    const action = (pub.body.actions as Array<{ body: string }>)[1]

    await n.waitFor(() => n.subscribes.length > 0)
    n.send("r1", action.body)
    await n.waitFor(() => f.replies[0])
    assert.deepEqual(f.replies[0], {
      sessionID: "root",
      formID: "frm_1",
      answer: { q0: "No" },
    })

    await cleanup()
    assert.equal(f.handlers.size, 0)
    await n.close()
  })
})
