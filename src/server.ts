/**
 * The server half: the bridge runs once, inside the OpenCode server, and sees
 * every session. A TUI only pilots it (src/remote.ts).
 *
 * The server plugin API has no form-reply call, so a question answered from a
 * chat is handed to an attached TUI, which makes the reply.
 */
import { randomUUID } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin"

import {
  Bridge,
  type BridgeEvent,
  type Host,
  type SessionInfo,
} from "./bridge.ts"
import { connectorTypes } from "./connectors/index.ts"
import type { Connector } from "./connectors/types.ts"
import { dataDir, loadConfig, type Config } from "./config.ts"
import { Control, sqliteProbe } from "./control.ts"
import { acquire, type Lock } from "./lock.ts"
import { log } from "./logger.ts"
import { resolveOtel, Telemetry } from "./otel.ts"
import { PendingStore } from "./pending.ts"
import { definition, type FormRelay } from "./rpc.ts"
import { Router } from "./routing.ts"
import { SettingsStore } from "./settings.ts"
import { isObject, sleep } from "./util.ts"

type Context = Plugin.Context

export const EVENTS: BridgeEvent["type"][] = [
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
  "session.inbox.enqueued",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.renamed",
  "session.model.selected",
  "session.agent.selected",
  "session.text.delta",
  "session.text.ended",
]
/** Read by the controller only: what leaves a session's inbox, and sessions that are gone. */
const WATCH = [
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.deleted",
]

const RESUME_TEXT =
  "Continue from where you left off: messages are waiting in your inbox. This was started from the chat bridge."
const FORM_WAIT_MS = 10_000
const STANDBY_MS = 15_000

type Info = {
  id: string
  parentID?: string
  agent?: string
  title?: string
  location?: { directory?: string }
  model?: { providerID: string; id: string; variant?: string }
  time?: { busy?: number; idle?: number }
}

/** What the server has told us of each session, so the bridge can read it without waiting. */
export class Sessions {
  readonly info = new Map<string, Info>()
  readonly running = new Set<string>()
  private readonly get: (id: string) => Promise<Info | undefined>

  constructor(get: (id: string) => Promise<Info | undefined>) {
    this.get = get
  }

  /** Loads a session and its parents, once. */
  async ensure(id: string | undefined): Promise<void> {
    for (let i = 0; id && i < 8 && !this.info.has(id); i++) {
      const info = await this.get(id)
      if (!info) return
      this.info.set(id, info)
      const { busy, idle } = info.time ?? {}
      if (busy !== undefined && (idle === undefined || busy > idle))
        this.running.add(id)
      id = info.parentID
    }
  }

  root(id: string): string {
    let cur = id
    for (let i = 0; i < 8; i++) {
      const p = this.info.get(cur)?.parentID
      if (!p) break
      cur = p
    }
    return cur
  }

  /** Keeps the cache current from the events that change it. */
  apply(e: { type: string; data?: unknown }): void {
    const d = (isObject(e.data) ? e.data : {}) as Record<string, unknown>
    const id = typeof d.sessionID === "string" ? d.sessionID : undefined
    if (!id) return
    const info = this.info.get(id)
    switch (e.type) {
      case "session.execution.started":
        this.running.add(id)
        break
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        this.running.delete(id)
        break
      case "session.renamed":
        if (info && typeof d.title === "string") info.title = d.title
        break
      case "session.agent.selected":
        if (info && typeof d.agent === "string") info.agent = d.agent
        break
      case "session.model.selected":
        if (info && isObject(d.model)) info.model = d.model as Info["model"]
        break
      case "session.deleted":
        this.info.delete(id)
        this.running.delete(id)
        break
    }
  }
}

const toSession = (i: Info): SessionInfo => ({
  id: i.id,
  parentID: i.parentID,
  agent: i.agent,
  directory: i.location?.directory,
  title: i.title,
  model: i.model?.id,
  modelRef: i.model && {
    providerID: i.model.providerID,
    id: i.model.id,
    variant: i.model.variant,
  },
})

const list = <T>(r: unknown): T[] =>
  Array.isArray(r)
    ? r
    : isObject(r) && Array.isArray(r.data)
      ? (r.data as T[])
      : []

/** Waits for a TUI to make a form reply the server cannot. */
class FormRelays {
  private readonly open = new Map<
    string,
    {
      ok: () => void
      fail: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  ask(
    emit: (r: FormRelay & { to?: string }) => void,
    r: Omit<FormRelay, "token">,
    to?: string,
  ): Promise<void> {
    if (!to)
      return Promise.reject(
        new Error(
          "No OpenCode window is open to deliver this answer. Answer it at the Mac.",
        ),
      )
    const token = randomUUID()
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.open.delete(token)
        fail(
          new Error(
            "No OpenCode window took the answer in time. Answer it at the Mac.",
          ),
        )
      }, FORM_WAIT_MS)
      timer.unref?.()
      this.open.set(token, { ok, fail, timer })
      emit({ ...r, token, to })
    })
  }

  done(token: string, ok: boolean, error?: string): boolean {
    const o = this.open.get(token)
    if (!o) return false
    clearTimeout(o.timer)
    this.open.delete(token)
    if (ok) o.ok()
    else o.fail(new Error(error || "The reply was refused"))
    return true
  }

  clear(): void {
    for (const [t, o] of this.open) {
      clearTimeout(o.timer)
      o.fail(new Error("The bridge restarted"))
      this.open.delete(t)
    }
  }
}

export function serverHost(
  ctx: Context,
  sessions: Sessions,
  forms: (r: Omit<FormRelay, "token">) => Promise<void>,
): Host {
  return {
    async session(id) {
      await sessions.ensure(id)
      const i = sessions.info.get(id)
      return i && toSession(i)
    },
    root: (id) => sessions.root(id),
    peek: (id) => {
      const i = sessions.info.get(id)
      return i && { agent: i.agent, directory: i.location?.directory }
    },
    replyForm: (sessionID, formID, answer) =>
      forms({ sessionID, formID, answer }),
    prompt: async (sessionID, text, delivery, files) => {
      await ctx.session.prompt({
        sessionID,
        text,
        delivery,
        files: files?.map((f) => ({
          uri: "data:" + f.mime + ";base64," + f.data,
          source: { type: "inline" as const },
          name: f.name,
        })),
      })
    },
    busy: (id) => sessions.running.has(id),
    createSession: async ({ directory, agent, model }) => {
      const info = await ctx.session.create({
        location: { directory },
        agent,
        model,
      })
      return { id: info.id }
    },
    switchModel: (sessionID, model) =>
      ctx.session.switchModel({ sessionID, model }),
    switchAgent: (sessionID, agent) =>
      ctx.session.switchAgent({ sessionID, agent }),
    interrupt: async (sessionID) =>
      (await ctx.session.interrupt({ sessionID })).interrupted,
    compact: async (sessionID) => {
      await ctx.session.compact({ sessionID })
    },
    rename: (sessionID, title) => ctx.session.update({ sessionID, title }),
    // The one public way to wake a session: a synthetic message that resumes it.
    resume: async (sessionID) => {
      await ctx.session.synthetic({
        sessionID,
        text: RESUME_TEXT,
        description: "Resumed from the chat",
        resume: true,
      })
    },
    agents: async () =>
      list<{ name: string; mode: string; hidden?: boolean }>(
        await ctx.agent.list(),
      )
        .filter((a) => a.mode !== "subagent" && !a.hidden)
        .map((a) => a.name),
    models: async () =>
      list<{
        providerID: string
        modelID: string
        name: string
        enabled: boolean
        status: string
        type?: string
        variants: Array<{ id: string }>
      }>(await ctx.model.list())
        .filter(
          (m) =>
            m.enabled &&
            m.status !== "deprecated" &&
            (m.type === undefined || m.type === "chat"),
        )
        .map((m) => ({
          ref: m.providerID + "/" + m.modelID,
          name: m.name,
          variants: m.variants.map((v) => v.id),
        })),
  }
}

async function version(): Promise<string> {
  try {
    const p = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string }
    return p.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

type Running = { control: Control; stop(): Promise<void> }

async function boot(
  ctx: Context,
  cfg: Config,
  lock: Extract<Lock, { held: true }>,
  forms: FormRelays,
  emit: (r: FormRelay & { to?: string }) => void,
  restart: () => Promise<void>,
): Promise<Running> {
  const tel = new Telemetry(resolveOtel(cfg.otel))
  const dir = dataDir()
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const connectors: Connector[] = Object.entries(cfg.channels).map(
    ([name, c]) => {
      const connector = connectorTypes[c.type].create(
        {
          name,
          dir,
          tel,
          settings: {
            get: () => settings.channel(name),
            set: (patch) => settings.set(name, patch),
          },
        },
        c.options,
      )
      connector.enabled = settings.channel(name).enabled ?? c.enabled
      return connector
    },
  )
  const store = new PendingStore(join(dir, "pending.jsonl"))
  await store.load()
  const router = new Router(cfg)
  for (const [id, v] of Object.entries(settings.sessions()))
    router.set(id, v.on, v.channel)

  const sessions = new Sessions(async (id) => {
    try {
      return (await ctx.session.get({ sessionID: id })) as unknown as Info
    } catch {
      return undefined
    }
  })
  let control!: Control
  const host = serverHost(ctx, sessions, (r) =>
    forms.ask(emit, r, control.pickTui()),
  )
  const bridge = new Bridge(cfg, host, connectors, store, router, Date.now, tel)
  const db = join(dirname(dir), "opencode.db")
  const probe = await access(db).then(
    () => sqliteProbe(db),
    () => undefined,
  )
  control = new Control({
    bridge,
    router,
    settings,
    cfg,
    host,
    owner: lock.owner,
    version: await version(),
    restart,
    probe,
  })
  for (const [id, v] of Object.entries(settings.sessions())) {
    if (v.chat) bridge.restoreChat(id)
    if (v.delivery === "queue" || v.delivery === "steer")
      bridge.restoreDelivery(id, v.delivery)
  }

  const ac = new AbortController()
  const feed = async () => {
    while (!ac.signal.aborted) {
      try {
        for await (const e of ctx.event.subscribe({
          types: [...EVENTS, ...WATCH] as never,
          signal: ac.signal,
        })) {
          const ev = e as unknown as { type: string; data?: unknown }
          control.onEvent(ev)
          const d = (isObject(ev.data) ? ev.data : {}) as Record<
            string,
            unknown
          >
          const form = isObject(d.form) ? d.form : {}
          const id =
            (typeof d.sessionID === "string" && d.sessionID) ||
            (typeof form.sessionID === "string" && form.sessionID) ||
            undefined
          await sessions.ensure(id || undefined)
          sessions.apply(ev)
          if ((EVENTS as string[]).includes(ev.type))
            void bridge.onEvent(ev as unknown as BridgeEvent)
        }
      } catch (err) {
        if (!ac.signal.aborted)
          log("event_stream_error", { message: (err as Error).message })
      }
      await sleep(2000, ac.signal)
    }
  }
  void feed()
  bridge.start()
  control.start()
  log("server_started", {
    otel: tel.enabled(),
    channels: connectors.map((c) => c.id),
    rules: cfg.rules.length,
    probe: probe !== undefined,
  })
  return {
    control,
    async stop() {
      ac.abort()
      control.stop()
      forms.clear()
      await bridge.stop()
      await settings.flush()
      await tel.dispose()
    },
  }
}

/** Starts the bridge in this server unless another loader already runs it. */
export async function startServer(
  ctx: Context,
): Promise<(() => Promise<void>) | undefined> {
  const cfg = await loadConfig()
  if (!cfg) return undefined
  if ("error" in cfg) {
    log("config_error", { message: cfg.error })
    return undefined
  }
  const lockFile = join(dataDir(), "owner.lock")
  const forms = new FormRelays()
  let running: Running | undefined
  let reg:
    | {
        dispose(): Promise<void>
        events: { emit: (...a: never[]) => Promise<void> }
      }
    | undefined
  let lock: Lock | undefined
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  const emit = (r: FormRelay & { to?: string }) =>
    void (
      reg?.events.emit as unknown as (n: string, d: unknown) => Promise<void>
    )?.("form", r).catch((err: Error) =>
      log("form_relay_error", { message: err.message }),
    )

  const restart = async () => {
    if (!lock?.held) return
    await running?.stop()
    running = await boot(ctx, cfg, lock, forms, emit, restart)
  }

  const take = async (): Promise<boolean> => {
    const l = await acquire(lockFile)
    if (!l.held) {
      log("server_standby", { owner: l.owner?.pid })
      return false
    }
    if (stopped) {
      await l.release()
      return true
    }
    lock = l
    const ctl = () => {
      if (!running) throw new Error("The bridge is restarting")
      return running.control
    }
    reg = (await ctx.rpc.register(definition, {
      status: async (input: unknown) => {
        const i = (isObject(input) ? input : {}) as {
          tui?: string
          inputAt?: number
          roots?: unknown
        }
        const roots = Array.isArray(i.roots)
          ? i.roots.filter((r): r is string => typeof r === "string")
          : []
        ctl().heartbeat(String(i.tui ?? "tui"), i.inputAt)
        ctl().watch(roots)
        return ctl().snapshot(roots) as never
      },
      op: async (input: unknown) => {
        const i = (isObject(input) ? input : {}) as {
          op?: string
          args?: Record<string, unknown>
        }
        return (await ctl().op(String(i.op ?? ""), i.args)) as never
      },
      formDone: async (input: unknown) => {
        const i = (isObject(input) ? input : {}) as {
          token?: string
          ok?: boolean
          error?: string
        }
        return {
          ok: forms.done(String(i.token ?? ""), i.ok === true, i.error),
        } as never
      },
    } as never)) as unknown as typeof reg
    running = await boot(ctx, cfg, l, forms, emit, restart)
    return true
  }

  if (!(await take())) {
    timer = setInterval(() => {
      if (stopped || running) return
      void take().then((ok) => {
        if (ok && timer) clearInterval(timer)
      })
    }, STANDBY_MS)
    timer.unref?.()
  }
  return async () => {
    stopped = true
    if (timer) clearInterval(timer)
    await running?.stop()
    await reg?.dispose().catch(() => {})
    if (lock?.held) await lock.release()
  }
}
