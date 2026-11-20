import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Bridge, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import type { Connector } from "./connectors/types.ts"
import { saveSession, type App } from "./menu.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { SettingsStore } from "./settings.ts"
import {
  activate,
  registerSidebar,
  sidebarLines,
  sidebarState,
  type Line,
  type SidebarState,
  type SidebarView,
} from "./sidebar.ts"
import { sleep } from "./util.ts"

const state = (o: Partial<SidebarState> = {}): SidebarState => ({
  mode: "auto",
  channel: "all",
  chat: false,
  chatCapable: true,
  delivery: "queue",
  override: false,
  open: 0,
  ...o,
})

const text = (lines: Line[]) =>
  lines.map((l) => l.parts.map((p) => p.text).join(""))

describe("sidebarLines", () => {
  it("shows routing with its channel, and chat with its delivery", () => {
    assert.deepEqual(
      text(
        sidebarLines(state({ mode: "on", channel: "telegram", chat: true })),
      ),
      ["📡 telegram · on", "💬 chat: on · queue"],
    )
    assert.deepEqual(text(sidebarLines(state({ mode: "off" }))), [
      "📡 off",
      "💬 chat: off · queue",
    ])
    assert.deepEqual(text(sidebarLines(state({ mode: "auto" }))), [
      "📡 all · auto",
      "💬 chat: off · queue",
    ])
  })

  it("marks a delivery the session chose itself", () => {
    const [, chat] = sidebarLines(
      state({ chat: true, delivery: "steer", override: true }),
    )
    assert.equal(chat.parts[1].text, " · steer*")
    assert.equal(chat.parts[1].tone, "warn")
  })

  it("shows open prompts only when there are some, in the singular too", () => {
    assert.equal(sidebarLines(state()).length, 2)
    assert.deepEqual(text(sidebarLines(state({ open: 1 })).slice(2)), [
      "⏳ 1 open prompt",
    ])
    assert.deepEqual(text(sidebarLines(state({ open: 3 })).slice(2)), [
      "⏳ 3 open prompts",
    ])
  })

  it("never more than three lines, and none of them wide", () => {
    const lines = sidebarLines(
      state({
        mode: "on",
        channel: "telegram",
        chat: true,
        delivery: "steer",
        override: true,
        open: 12,
      }),
    )
    assert.equal(lines.length, 3)
    for (const t of text(lines)) assert.ok(t.length <= 28, t)
  })

  it("says denied, with no delivery to toggle, when chat.deny blocks the session", () => {
    const [, chat] = sidebarLines(state({ blocked: "directory **/payroll" }))
    assert.deepEqual(text([chat]), ["💬 chat: denied"])
    assert.equal(chat.parts.length, 1)
    assert.equal(chat.parts[0].tone, "warn")
    assert.equal(chat.parts[0].action, "chat")
  })

  it("has no chat line when no selected channel can chat", () => {
    assert.deepEqual(text(sidebarLines(state({ chatCapable: false }))), [
      "📡 all · auto",
    ])
  })

  it("routing, chat and delivery are clickable; open prompts are not", () => {
    const lines = sidebarLines(state({ chat: true, open: 1 }))
    assert.deepEqual(
      lines.flatMap((l) => l.parts.map((p) => p.action)),
      ["route", "chat", "delivery", undefined],
    )
  })
})

function rig(
  chat: Record<string, unknown> = {},
  o: { canChat?: boolean } = {},
) {
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
    chat,
  }) as Config
  const connector = {
    id: "telegram",
    type: "telegram",
    enabled: true,
    capabilities: {
      buttons: true,
      edit: true,
      multiselect: true,
      rich: true,
      threads: true,
      pairing: true,
      inboundPrompt: o.canChat !== false,
    },
    start() {},
    hint: () => "",
    send: async () => undefined,
    status: () => ({}),
  } as unknown as Connector
  const facts = { agent: "coord", directory: "/w/shop" }
  const host = {
    session: async (id: string) => ({ id, ...facts, title: "T" }),
    peek: () => facts,
    root: (id: string) => id,
    replyForm: async () => {},
    prompt: async () => {},
    busy: () => false,
  } as unknown as Host
  const store = new PendingStore()
  const router = new Router(cfg, async () => true)
  const bridge = new Bridge(cfg, host, [connector], store, router)
  const settings = new SettingsStore()
  const app: App = { router, bridge, settings }
  bridge.onChat((root) => saveSession(app, root))
  return { app, store, bridge, router, settings }
}

describe("sidebarState and activate", () => {
  it("reads the state of a session from the bridge", () => {
    const { app } = rig()
    assert.deepEqual(sidebarState(app, "root"), {
      mode: "auto",
      channel: "all",
      chat: false,
      blocked: undefined,
      chatCapable: true,
      delivery: "queue",
      override: false,
      open: 0,
    })
  })

  it("a click on routing cycles auto, on, off, auto, and keeps the choice", async () => {
    const { app, settings } = rig()
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      const out = await activate(app, "root", "route")
      assert.equal(out.ok, true)
      seen.push(app.router.mode("root"))
    }
    assert.deepEqual(seen, ["on", "off", "auto"])
    assert.equal(settings.sessions().root, undefined, "auto needs no record")
    await activate(app, "root", "route")
    assert.equal(app.router.mode("root"), "on")
    assert.equal(settings.sessions().root.on, true)
    assert.match((await activate(app, "root", "route")).text, /Routing off/)
    assert.equal(settings.sessions().root.on, false)
  })

  it("a click on chat turns it on and off", async () => {
    const { app } = rig()
    assert.equal((await activate(app, "root", "chat")).ok, true)
    assert.equal(app.bridge.chatEnabled("root"), true)
    assert.equal(sidebarState(app, "root").chat, true)
    assert.equal((await activate(app, "root", "chat")).ok, true)
    assert.equal(app.bridge.chatEnabled("root"), false)
  })

  it("chat.deny shows denied, and a click says why and changes nothing", async () => {
    const { app } = rig({ deny: [{ directory: "**/shop" }] })
    const s = sidebarState(app, "root")
    assert.equal(s.blocked, "directory **/shop")
    assert.deepEqual(text(sidebarLines(s)), [
      "📡 all · auto",
      "💬 chat: denied",
    ])
    const out = await activate(app, "root", "chat")
    assert.equal(out.ok, false)
    assert.match(out.text, /blocked .* chat\.deny .*directory \*\*\/shop/)
    assert.equal(app.bridge.chatEnabled("root"), false)
  })

  it("a click on delivery flips queue and steer for the session, and keeps it in the settings", async () => {
    const { app, settings } = rig()
    const out = await activate(app, "root", "delivery")
    assert.match(out.text, /Delivery: steer/)
    assert.equal(app.bridge.delivery("root"), "steer")
    assert.equal(settings.sessions().root.delivery, "steer")
    assert.equal(sidebarState(app, "root").override, true)
    // Back at the default: no override left.
    assert.match(
      (await activate(app, "root", "delivery")).text,
      /Delivery: queue/,
    )
    assert.equal(app.bridge.deliveryOverride("root"), undefined)
    assert.equal(settings.sessions().root, undefined)
  })

  it("with chat.delivery steer, the first click goes to queue and is the override", async () => {
    const { app, settings } = rig({ delivery: "steer" })
    assert.equal(app.bridge.delivery("root"), "steer")
    await activate(app, "root", "delivery")
    assert.equal(app.bridge.delivery("root"), "queue")
    assert.equal(settings.sessions().root.delivery, "queue")
  })

  it("open prompts of the session are counted", () => {
    const { app, store } = rig()
    const base = {
      kind: "question" as const,
      requestID: "r",
      title: "t",
      askedAt: 1,
    }
    store.put({
      ...base,
      id: "a",
      sessionID: "root",
      rootSessionID: "root",
      state: "pending",
    })
    store.put({
      ...base,
      id: "b",
      sessionID: "x",
      rootSessionID: "other",
      state: "pending",
    })
    store.put({
      ...base,
      id: "c",
      sessionID: "root",
      rootSessionID: "root",
      state: "answered" as never,
    })
    assert.equal(sidebarState(app, "root").open, 1)
  })
})

function fakeCtx() {
  const claims: Array<{
    append?: string
    render: (i: { sessionID: string }) => unknown
  }> = []
  const toasts: Array<{ message: string; variant?: string }> = []
  let released = 0
  const ctx = {
    data: { session: { root: (id: string) => (id === "child" ? "root" : id) } },
    ui: {
      slot: (c: (typeof claims)[number]) => {
        claims.push(c)
        return () => void released++
      },
      toast: {
        show: (o: { message: string; variant?: string }) => toasts.push(o),
      },
    },
    theme: {
      text: {
        base: "#ffffff",
        muted: { base: "#888888", hover: "#aaaaaa" },
        feedback: { success: "#00ff00", warning: "#ffaa00" },
      },
    },
  }
  return { ctx: ctx as never, claims, toasts, released: () => released }
}

describe("registerSidebar with a fake slot registry", () => {
  const capture = () => {
    const seen: Array<Parameters<SidebarView>[0]> = []
    const view: SidebarView = (p) => {
      seen.push(p)
      return { drawn: true }
    }
    return { seen, view }
  }

  it("claims the end of sidebar.content, and draws what the view returns", () => {
    const f = fakeCtx()
    const { view } = capture()
    registerSidebar(f.ctx, view)
    assert.equal(f.claims.length, 1)
    assert.equal(f.claims[0].append, "sidebar.content")
    assert.deepEqual(f.claims[0].render({ sessionID: "root" }), { drawn: true })
  })

  it("is empty until attached, then follows the session in view (a child shows its root)", () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    f.claims[0].render({ sessionID: "child" })
    assert.deepEqual(seen[0].lines(), [])
    sb.attach(rig({}).app)
    assert.deepEqual(text(seen[0].lines()), [
      "📡 all · auto",
      "💬 chat: off · queue",
    ])
  })

  it("tells the view when something changed, and stops after it unsubscribes", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = rig()
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "root" })
    let n = 0
    const off = seen[0].subscribe(() => n++)
    await r.bridge.setChat("root", true)
    assert.ok(n >= 1, "chat toggle")
    const after = n
    r.store.put({
      id: "a",
      kind: "question",
      requestID: "r",
      title: "t",
      askedAt: 1,
      sessionID: "root",
      rootSessionID: "root",
      state: "pending",
    })
    assert.ok(n > after, "a new prompt")
    assert.deepEqual(text(seen[0].lines()), [
      "📡 all · on",
      "💬 chat: on · queue",
      "⏳ 1 open prompt",
    ])
    const stop = n
    off()
    r.bridge.setDelivery("root", "steer")
    assert.equal(n, stop)
    assert.equal(text(seen[0].lines())[1], "💬 chat: on · steer*")
  })

  it("activate runs the click on the session in view and toasts the result", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = rig({ deny: [{ agent: "^coord$" }] })
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "child" })
    seen[0].activate("route")
    await sleep(20)
    assert.equal(r.router.mode("root"), "on")
    assert.deepEqual(f.toasts.at(-1), {
      message: "Routing on via all",
      variant: "success",
    })
    seen[0].activate("chat")
    await sleep(20)
    assert.equal(f.toasts.at(-1)!.variant, "warning")
    assert.match(f.toasts.at(-1)!.message, /agent \^coord\$/)
  })

  it("an activation before the bridge exists does nothing", async () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    registerSidebar(f.ctx, view)
    f.claims[0].render({ sessionID: "root" })
    seen[0].activate("route")
    await sleep(20)
    assert.deepEqual(f.toasts, [])
  })

  it("hands the view the theme's colours, reading { base } state sets", () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    registerSidebar(f.ctx, view)
    f.claims[0].render({ sessionID: "root" })
    assert.deepEqual(seen[0].colors(), {
      normal: "#ffffff",
      muted: "#888888",
      ok: "#00ff00",
      warn: "#ffaa00",
    })
  })

  it("dispose releases the claim and stops the updates", () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    const r = rig()
    sb.attach(r.app)
    f.claims[0].render({ sessionID: "root" })
    let n = 0
    seen[0].subscribe(() => n++)
    sb.dispose()
    assert.equal(f.released(), 1)
    r.bridge.setDelivery("root", "steer")
    assert.equal(n, 0)
  })

  it("no chat line for a session whose channel cannot chat", () => {
    const f = fakeCtx()
    const { view, seen } = capture()
    const sb = registerSidebar(f.ctx, view)
    sb.attach(rig({}, { canChat: false }).app)
    f.claims[0].render({ sessionID: "root" })
    assert.deepEqual(text(seen[0].lines()), ["📡 all · auto"])
  })
})
