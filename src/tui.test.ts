import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { fakeNtfy } from "./connectors/fake-ntfy.test-util.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import plugin, { setup } from "./tui.ts"

type Handler = (e: unknown) => void

function fakeCtx(size?: { width: number; height: number }) {
  const handlers = new Map<string, Handler>()
  const replies: unknown[] = []
  const toasts: string[] = []
  const commands: Array<{
    palette?: boolean
    slash?: { name: string; aliases?: string[] }
    run: (i?: string) => unknown
  }> = []
  const dialogs: Array<{
    title: string
    message?: string
    options?: Array<{ title: string; value: unknown; description?: string }>
    current?: unknown
  }> = []
  // What the operator picks, in order; undefined dismisses.
  const picks: unknown[] = []
  let cleared = 0
  const modes: Array<string | undefined> = []
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
    renderer: size,
    client: { session: { get: async () => undefined } },
    keymap: {
      layer: (f: () => { mode?: string; commands: typeof commands }) => {
        const l = f()
        modes.push(l.mode)
        commands.push(...l.commands)
      },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "root" }) },
      toast: { show: (o: { message: string }) => toasts.push(o.message) },
      dialog: {
        select: async (o: (typeof dialogs)[number]) => {
          dialogs.push(o)
          return picks.shift()
        },
        alert: async (o: (typeof dialogs)[number]) => {
          dialogs.push(o)
          await new Promise((r) => setTimeout(r, 30))
        },
        clear: () => cleared++,
      },
    },
  }
  return {
    ctx: ctx as never,
    handlers,
    replies,
    toasts,
    commands,
    modes,
    dialogs,
    picks,
    cleared: () => cleared,
  }
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
    assert.equal(plugin.id, "oob-bridge.tui")
    assert.equal(typeof plugin.setup, "function")
  })

  it("AC-14: without config it only registers /ntfy and makes no request", async () => {
    const f = fakeCtx()
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error("no network expected")
    }) as typeof fetch
    try {
      const cleanup = await withEnv(
        { OPENCODE_OOB_BRIDGE_CONFIG: "/nonexistent/oob-bridge.jsonc" },
        () => setup(f.ctx),
      )
      assert.equal(cleanup, undefined)
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      globalThis.fetch = realFetch
    }
    assert.equal(calls, 0)
    assert.equal(f.handlers.size, 0)
    // /ntfy is registered before any await (OpenCode 2.3.2 drops later layers);
    // without config it only explains itself.
    assert.equal(f.commands.length, 1)
    // The default "base" mode is inactive while the prompt has focus.
    assert.deepEqual(f.modes, ["global"])
  })

  it("stays inert on an invalid config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-tui-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(cfg, JSON.stringify({ server: "x", token: "literal" }))
    const f = fakeCtx()
    const cleanup = await withEnv({ OPENCODE_OOB_BRIDGE_CONFIG: cfg }, () =>
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
        OPENCODE_OOB_BRIDGE_CONFIG: cfg,
        OPENCODE_OOB_BRIDGE_DATA: dir,
        NTFYB_T: "tk_test_token_abcdefghijklmnop",
      },
      () => setup(f.ctx),
    )
    assert.ok(cleanup)
    assert.ok(f.handlers.has("form.created"))
    const cmd = f.commands.find((c) => c.slash?.name === "oob")!
    cmd.run("on")
    assert.equal(f.toasts.at(-1), "oob routing: on")
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

async function readJson(file: string, ms = 3000) {
  const end = Date.now() + ms
  for (;;) {
    try {
      return JSON.parse(await readFile(file, "utf8"))
    } catch (err) {
      if (Date.now() > end) throw err
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

describe("/oob menu and channels", () => {
  // Tokens resolve lazily, after setup has returned.
  before(() => void (process.env.OOBB_TG = "123456:TESTTOKEN"))
  after(() => void delete process.env.OOBB_TG)

  async function started(
    channels: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    size?: { width: number; height: number },
    dir?: string,
  ) {
    dir ??= await mkdtemp(join(tmpdir(), "oobb-menu-"))
    const cfg = join(dir, "c.jsonc")
    await writeFile(cfg, JSON.stringify({ channels, ...extra }))
    const f = fakeCtx(size)
    const cleanup = await withEnv(
      {
        OPENCODE_OOB_BRIDGE_CONFIG: cfg,
        OPENCODE_OOB_BRIDGE_DATA: dir,
      },
      () => setup(f.ctx),
    )
    assert.ok(cleanup)
    const cmd = f.commands.find((c) => c.slash?.name === "oob")!
    return { f, dir, cmd, cleanup }
  }

  it("is a palette command with the ntfy alias, registered synchronously", async () => {
    const f = fakeCtx()
    void setup(f.ctx)
    assert.equal(f.commands.length, 1)
    assert.equal(f.commands[0].palette, true)
    assert.deepEqual(f.commands[0].slash?.aliases, ["ntfy"])
    assert.deepEqual(f.modes, ["global"])
  })

  it("opens a menu with routing, channels, pairing, test and status", async () => {
    const n = await fakeNtfy()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: { token: { env: "OOBB_TG" } },
    })
    await cmd.run()
    const m = f.dialogs[0]
    assert.deepEqual(
      m.options!.map((o) => o.value),
      ["routing", "channels", "pair:telegram", "test", "status"],
    )
    assert.equal(m.options![0].description, "now: auto")
    assert.equal(m.options![1].description, "ntfy on, telegram on")

    f.picks.push("routing", "off")
    await cmd.run()
    assert.equal(
      f.dialogs.find((d) => d.title === "This session")!.current,
      "auto",
    )
    assert.equal(f.toasts.at(-1), "oob routing: off")
    await cmd.run("auto")
    assert.equal(f.toasts.at(-1), "oob routing: auto")
    await cleanup()
    await n.close()
  })

  it("switches a channel off, persists it, and stops its subscription", async () => {
    const n = await fakeNtfy()
    const { f, dir, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
    })
    await n.waitFor(() => n.subscribes.length > 0)
    f.picks.push("channels", "ntfy")
    await cmd.run()
    assert.equal(f.toasts.at(-1), "ntfy: off")
    const saved = await readJson(join(dir, "settings.json"))
    assert.equal(saved.channels.ntfy.enabled, false)
    await cleanup()
    await n.close()

    // The next start honours it: no subscription, nothing sent.
    const n2 = await fakeNtfy()
    await writeFile(
      join(dir, "c.jsonc"),
      JSON.stringify({
        channels: { ntfy: { server: n2.url, topics: { out: "o", in: "i" } } },
      }),
    )
    const f2 = fakeCtx()
    const cleanup2 = await withEnv(
      {
        OPENCODE_OOB_BRIDGE_CONFIG: join(dir, "c.jsonc"),
        OPENCODE_OOB_BRIDGE_DATA: dir,
      },
      () => setup(f2.ctx),
    )
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(n2.subscribes.length, 0)
    await f2.commands[0].run("test")
    assert.equal(f2.toasts.at(-1), "No channel is enabled")
    await cleanup2!()
    await n2.close()
  })

  it("sends a test push to every enabled channel and shows status", async () => {
    const n = await fakeNtfy()
    const tg = await fakeTelegram()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: {
        token: { env: "OOBB_TG" },
        chatId: 7,
        apiBase: tg.url,
      },
    })
    await cmd.run("test")
    assert.equal(f.toasts.at(-1), "Test push: ntfy sent, telegram sent")
    assert.equal(n.published.length, 1)
    assert.match(tg.of("sendMessage")[0].body.text, /Test push/)

    await cmd.run("status")
    const msg = f.dialogs.at(-1)!.message!
    assert.match(msg, /^ntfy: on/m)
    assert.match(msg, /^telegram: on/m)
    assert.match(msg, /Open prompts: 0/)
    await cleanup()
    await n.close()
    await tg.close()
  })

  it("pairs Telegram from a one-time code and stores the chat in the settings", async () => {
    const tg = await fakeTelegram()
    const { f, dir, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url },
    })
    await cmd.run("pair telegram")
    const dlg = f.dialogs.at(-1)!
    const code = /send this code: ([A-Z2-9]{6})/.exec(dlg.message!)![1]
    assert.match(
      dlg.message!,
      new RegExp(`https://t.me/oob_test_bot\\?start=${code}`),
    )
    // The QR of that link is in the dialog, and it fits.
    assert.match(dlg.message!, /Scan with your phone camera/)
    assert.match(dlg.message!, /█/)
    tg.message(555, code)
    await tg.waitFor(() => f.toasts.includes("telegram paired") || undefined)
    const saved = await readJson(join(dir, "settings.json"))
    assert.equal(saved.channels.telegram.chatId, "555")
    // Never written to the user's config file.
    assert.doesNotMatch(await readFile(join(dir, "c.jsonc"), "utf8"), /555/)

    await cmd.run("test")
    assert.equal(tg.of("sendMessage").at(-1)!.body.chat_id, "555")
    await cleanup()
    await tg.close()
  })

  it("pairs through the deep link: /start <code> is the pairing message", async () => {
    const tg = await fakeTelegram()
    const { f, dir, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url },
    })
    await cmd.run("pair telegram")
    const code = /this code: ([A-Z2-9]{6})/.exec(f.dialogs.at(-1)!.message!)![1]
    tg.message(556, `/start ${code}`)
    await tg.waitFor(() => f.toasts.includes("telegram paired") || undefined)
    assert.equal(
      (await readJson(join(dir, "settings.json"))).channels.telegram.chatId,
      "556",
    )
    await cleanup()
    await tg.close()
  })

  it("falls back to link and code when the terminal is too small for the QR", async () => {
    const tg = await fakeTelegram()
    const small = await started(
      { telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url } },
      {},
      { width: 50, height: 20 },
    )
    await small.cmd.run("pair telegram")
    const msg = small.f.dialogs.at(-1)!.message!
    assert.doesNotMatch(msg, /Scan with your phone camera|█/)
    assert.match(msg, /https:\/\/t\.me\/oob_test_bot\?start=/)
    assert.match(msg, /this code: [A-Z2-9]{6}/)
    await small.cleanup()

    const big = await started(
      { telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url } },
      {},
      { width: 120, height: 50 },
    )
    await big.cmd.run("pair telegram")
    assert.match(big.f.dialogs.at(-1)!.message!, /Scan with your phone camera/)
    await big.cleanup()
    await tg.close()
  })

  it("chooses a channel per session, persists it and restores it after a restart", async () => {
    const n = await fakeNtfy()
    const tg = await fakeTelegram()
    const channels = {
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url },
    }
    const { f, dir, cmd, cleanup } = await started(channels)
    await cmd.run("on telegram")
    assert.equal(f.toasts.at(-1), "oob routing: on via telegram")
    await cmd.run("on bogus")
    assert.match(f.toasts.at(-1)!, /No channel "bogus"/)
    await cmd.run("on telegram extra")
    assert.match(f.toasts.at(-1)!, /Usage/)

    // The session now asks: only Telegram hears it.
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
              options: [{ label: "A" }, { label: "B" }],
            },
          ],
        },
      },
    })
    await tg.waitFor(() => tg.of("sendMessage")[0])
    assert.equal(n.published.length, 0)

    const saved = await readJson(join(dir, "settings.json"))
    assert.deepEqual(saved.sessions, {
      root: { on: true, channel: "telegram" },
    })
    await cleanup()

    const again = await started(channels, {}, undefined, dir)
    await again.cmd.run()
    const m = again.f.dialogs.at(-1)!
    assert.equal(m.options![0].description, "now: on via telegram")
    again.f.picks.push("routing", "auto")
    await again.cmd.run()
    const r = again.f.dialogs.find((d) => d.title === "This session")!
    assert.equal(r.current, "on:telegram")
    assert.deepEqual(
      r.options!.map((o) => o.value),
      ["on", "on:ntfy", "on:telegram", "on:all", "off", "auto", "back"],
    )
    assert.equal(again.f.toasts.at(-1), "oob routing: auto")
    await again.cleanup()
    assert.deepEqual((await readJson(join(dir, "settings.json"))).sessions, {})
    await n.close()
    await tg.close()
  })

  it("the main menu loops until Esc; submenus return to it with Back", async () => {
    const n = await fakeNtfy()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
    })
    // routing -> Back, status, test, then Esc (undefined).
    f.picks.push("routing", "back", "status", "test")
    await cmd.run()
    assert.deepEqual(
      f.dialogs.map((d) => d.title),
      [
        "OOB bridge",
        "This session",
        "OOB bridge",
        "OOB bridge status",
        "OOB bridge",
        "OOB bridge",
      ],
    )
    assert.ok(f.dialogs[1].options!.at(-1)!.value === "back")
    assert.equal(
      f.toasts.some((t) => t.startsWith("oob routing")),
      false,
      "Back changes nothing",
    )
    assert.match(f.toasts.at(-1)!, /^Test push/)
    await cleanup()
    await n.close()
  })

  it("the channel list stays open for several switches, until Back", async () => {
    const n = await fakeNtfy()
    const tg = await fakeTelegram()
    const { f, dir, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
      telegram: { token: { env: "OOBB_TG" }, chatId: 7, apiBase: tg.url },
    })
    f.picks.push("channels", "ntfy", "telegram", "ntfy", "back")
    await cmd.run()
    const lists = f.dialogs.filter((d) => d.title.startsWith("Channels"))
    assert.equal(lists.length, 4)
    assert.equal(lists[0].options!.at(-1)!.value, "back")
    assert.deepEqual(
      lists.map((l) => l.options!.slice(0, 2).map((o) => o.title)),
      [
        ["ntfy: on", "telegram: on"],
        ["ntfy: off", "telegram: on"],
        ["ntfy: off", "telegram: off"],
        ["ntfy: on", "telegram: off"],
      ],
    )
    const saved = await readJson(join(dir, "settings.json"))
    assert.equal(saved.channels.ntfy.enabled, true)
    assert.equal(saved.channels.telegram.enabled, false)
    await cleanup()
    await n.close()
    await tg.close()
  })

  it("pairing from the menu returns to the menu when its dialog closes", async () => {
    const tg = await fakeTelegram()
    const { f, cmd, cleanup } = await started({
      telegram: { token: { env: "OOBB_TG" }, apiBase: tg.url },
    })
    f.picks.push("pair:telegram")
    await cmd.run()
    assert.deepEqual(
      f.dialogs.map((d) => d.title),
      ["OOB bridge", "Pair telegram", "OOB bridge"],
    )
    // From the command line the command returns at once, without waiting for the dialog.
    const before = f.dialogs.length
    await cmd.run("pair telegram")
    assert.equal(f.dialogs.length, before + 1)
    await cleanup()
    await tg.close()
  })

  it("explains itself when Telegram is not configured", async () => {
    const n = await fakeNtfy()
    const { f, cmd, cleanup } = await started({
      ntfy: { server: n.url, topics: { out: "o", in: "i" } },
    })
    await cmd.run("pair telegram")
    assert.match(f.toasts.at(-1)!, /No channel can be paired/)
    await cmd.run("bogus")
    assert.match(f.toasts.at(-1)!, /Usage/)
    await cleanup()
    await n.close()
  })
})
