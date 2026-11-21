import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Bridge, type Host } from "./bridge.ts"
import { parseConfig, type Config } from "./config.ts"
import { Control, PRESENCE_MS, STUCK_MS, type Probe } from "./control.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { SettingsStore } from "./settings.ts"

const CHAT = 4242

async function rig(
  o: {
    resume?: "ok" | "none" | "fail"
    busy?: boolean
    probe?: Probe
    route?: boolean
  } = {},
) {
  const tg = await fakeTelegram()
  tg.forum = true
  const dir = await mkdtemp(join(tmpdir(), "oobb-control-"))
  const channel = new TelegramConnector({
    token: async () => tg.token,
    chatId: String(CHAT),
    apiBase: tg.url,
    topicsFile: join(dir, "topics.json"),
    offsetFile: join(dir, "offset.json"),
    pollSeconds: 1,
    backoff: { min: 10, max: 40 },
  })
  const cfg = parseConfig({
    channels: { telegram: { token: { env: "X" } } },
  }) as Config
  const clock = { t: 1_000_000 }
  const now = () => clock.t
  const resumed: string[] = []
  const state = { busy: o.busy ?? false }
  const host: Host = {
    session: async (id) =>
      id === "root"
        ? { id, agent: "coord", directory: "/w/shop", title: "Shop" }
        : undefined,
    root: (id) => (id === "child" ? "root" : id),
    replyForm: async () => {},
    prompt: async () => {},
    busy: () => state.busy,
    ...(o.resume === "none"
      ? {}
      : {
          resume: async (id: string) => {
            if (o.resume === "fail") throw new Error("refused")
            resumed.push(id)
          },
        }),
  }
  const router = new Router(cfg, async () => true, now)
  router.set("root", o.route !== false)
  const bridge = new Bridge(cfg, host, [channel], new PendingStore(), router)
  const settings = new SettingsStore()
  const control = new Control({
    bridge,
    router,
    settings,
    cfg,
    host,
    owner: { pid: 1, startedAt: now() },
    version: "t",
    now,
    probe: o.probe,
  })
  bridge.start()
  const enqueue = (id: string, sessionID = "root", type = "user") =>
    control.onEvent({
      type: "session.inbox.enqueued",
      data: { sessionID, inboxID: id, item: { type } },
    })
  return {
    tg,
    bridge,
    control,
    router,
    settings,
    clock,
    state,
    resumed,
    enqueue,
    sends: () => tg.of("sendMessage").map((c) => c.body),
    async done() {
      control.stop()
      await bridge.stop()
      await tg.close()
    },
  }
}

describe("who counts as away", () => {
  it("with no window attached the operator is away, and the windows decide otherwise", async () => {
    const r = await rig()
    assert.equal(r.control.snapshot().afk.away, true)
    assert.equal(r.control.snapshot().afk.tuis, 0)
    const t0 = r.clock.t
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, false)
    assert.equal(r.control.snapshot().afk.tuis, 1)
    // The window stays attached but its operator stops typing.
    r.clock.t = t0 + cfgMinutes() * 60_000 - 1
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, false)
    r.clock.t += 1
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, true)
    assert.equal(r.control.snapshot().afk.tuis, 1)
    await r.done()
  })

  it("input in any window counts, and a window that stops reporting is gone", async () => {
    const r = await rig()
    const t0 = r.clock.t
    r.control.heartbeat("a", t0)
    r.clock.t += cfgMinutes() * 60_000 + 1
    r.control.heartbeat("a", t0)
    assert.equal(r.control.snapshot().afk.away, true)
    // Another window reports fresh input: present again, for the whole instance.
    r.control.heartbeat("b", r.clock.t)
    assert.equal(r.control.snapshot().afk.away, false)
    assert.equal(r.control.snapshot().afk.tuis, 2)
    r.clock.t += PRESENCE_MS + 1
    assert.equal(r.control.attached(), 0)
    assert.equal(r.control.snapshot().afk.away, true)
    await r.done()
  })

  it("afk on and off override the windows, and are kept", async () => {
    const r = await rig()
    assert.equal(
      (await r.control.op("afk", { mode: "off" })).snapshot.afk.away,
      false,
    )
    assert.equal(r.settings.afk(), "off")
    r.control.heartbeat("a", r.clock.t)
    assert.equal(
      (await r.control.op("afk", { mode: "on" })).snapshot.afk.away,
      true,
    )
    assert.equal(
      (await r.control.op("afk", { mode: "auto" })).snapshot.afk.away,
      false,
    )
    const bad = await r.control.op("afk", { mode: "sometimes" })
    assert.equal(bad.ok, false)
    await r.done()
  })
})

const cfgMinutes = () => 10

describe("a session with messages it is not working on", () => {
  it("is told once to the topic, with a Resume button, after the grace period", async () => {
    const r = await rig()
    r.enqueue("i1")
    assert.deepEqual(r.control.stuck(), [])
    r.clock.t += STUCK_MS + 1
    assert.equal(r.control.stuck().length, 1)
    await r.control.scan()
    const sent = await r.tg.waitFor(() =>
      r.sends().find((b) => /has waited 1 min/.test(b.text)),
    )
    assert.deepEqual(sent.reply_markup, {
      inline_keyboard: [[{ text: "▶ Resume", callback_data: "ctl:resume" }]],
    })
    const n = r.sends().length
    await r.control.scan()
    assert.equal(r.sends().length, n)
    assert.equal(r.control.stuck()[0].alerted, true)
    await r.done()
  })

  it("tapping Resume wakes the session and says so", async () => {
    const r = await rig()
    r.enqueue("i1")
    r.clock.t += STUCK_MS + 1
    await r.control.scan()
    await r.tg.waitFor(() =>
      r.sends().find((b) => /Resume wakes it/.test(b.text)),
    )
    r.tg.callback(CHAT, 701, "ctl:resume", 9001)
    const ans = await r.tg.waitFor(() => r.tg.of("answerCallbackQuery")[0])
    assert.match(ans.body.text, /Resuming/)
    assert.deepEqual(r.resumed, ["root"])
    await r.done()
  })

  it("says to open it at the Mac when the host cannot or will not resume", async () => {
    const refuses = await rig({ resume: "fail" })
    assert.match(
      (await refuses.control.op("resume", { root: "root" })).text!,
      /Open it at the Mac/,
    )
    await refuses.done()
    const none = await rig({ resume: "none" })
    none.enqueue("i1")
    none.clock.t += STUCK_MS + 1
    await none.control.scan()
    const note = await none.tg.waitFor(() =>
      none.sends().find((b) => /has waited/.test(b.text)),
    )
    assert.equal(note.reply_markup, undefined)
    const out = await none.control.op("resume", { root: "root" })
    assert.equal(out.ok, false)
    assert.match(out.text!, /Open it at the Mac/)
    await none.done()
  })

  it("is not stuck once the message is delivered, while it works, or when it is a subagent's", async () => {
    const r = await rig()
    r.enqueue("i1")
    r.control.onEvent({
      type: "session.inbox.delivered",
      data: { sessionID: "root", inboxID: "i1" },
    })
    r.clock.t += STUCK_MS + 1
    assert.deepEqual(r.control.stuck(), [])
    r.enqueue("i2")
    r.clock.t += STUCK_MS + 1
    r.state.busy = true
    assert.deepEqual(r.control.stuck(), [])
    r.state.busy = false
    assert.equal(r.control.stuck().length, 1)
    r.control.onEvent({ type: "session.deleted", data: { sessionID: "root" } })
    assert.deepEqual(r.control.stuck(), [])
    r.enqueue("i3", "child")
    r.enqueue("i4", "root", "synthetic")
    assert.deepEqual(r.control.stuck(), [])
    await r.done()
  })

  it("is also found from the database when the events were missed", async () => {
    const r = await rig({
      probe: async () => [
        { id: "root", pending: 3, since: 1_000_000 - 5 * 60_000 },
      ],
    })
    await r.control.refreshProbe()
    const [s] = r.control.stuck()
    assert.equal(s.source, "db")
    assert.equal(s.pending, 3)
    await r.tg.waitFor(() => r.sends().find((b) => /3 messages/.test(b.text)))
    assert.equal(r.control.snapshot().stuck.length, 1)
    await r.done()
  })

  it("a session that is not mirrored is listed but nothing is sent", async () => {
    const r = await rig({ route: false })
    r.enqueue("i1")
    r.clock.t += STUCK_MS + 1
    await r.control.scan()
    assert.equal(r.control.stuck().length, 1)
    assert.deepEqual(r.sends(), [])
    await r.done()
  })
})

describe("commands from a window", () => {
  it("routes and chats for any session, keeps it, and refuses what it does not know", async () => {
    const r = await rig({ route: false })
    const a = await r.control.op("route", { root: "root", mode: "on" })
    assert.equal(a.ok, true)
    assert.equal(a.snapshot.sessions.find((s) => s.id === "root")?.mode, "on")
    assert.equal(r.settings.sessions().root.on, true)
    assert.equal(
      (await r.control.op("route", { root: "root", mode: "maybe" })).ok,
      false,
    )
    assert.equal((await r.control.op("nope")).ok, false)
    assert.equal((await r.control.op("resume")).ok, false)
    await r.done()
  })
})
