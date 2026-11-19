/**
 * The bridge: OpenCode events in, pushes out to the enabled connectors, replies
 * back in from any of them. It reads connector capabilities, never their type.
 *
 * Questions (tier 1) can be answered from a channel. Permission prompts are
 * tier 3: push only. There is deliberately no code path that replies to one.
 */
import { basename } from "node:path"

import type {
  Card,
  CardQuestion,
  Connector,
  ConnectorStatus,
  Inbound,
  Outcome,
  Pairing,
  Push,
  SendStats,
  SessionState,
} from "./connectors/types.ts"
import type { Config } from "./config.ts"
import { redact } from "./filter.ts"
import {
  resolveAnswer,
  type Answer,
  type Question,
  type Reply,
} from "./inbound.ts"
import { log } from "./logger.ts"
import { format, isCustomized, type Kind, type Vars } from "./messages.ts"
import { noTelemetry, type Telemetry } from "./otel.ts"
import type { Pending, PendingStore } from "./pending.ts"
import type { Router, SessionFacts } from "./routing.ts"
import { clock, formatDuration, truncate } from "./util.ts"

export type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  directory?: string
  title?: string
  model?: string
}

/** What the bridge needs from OpenCode. */
export interface Host {
  session(id: string): Promise<SessionInfo | undefined>
  root(id: string): string
  replyForm(sessionID: string, formID: string, answer: Answer): Promise<void>
}

type FormOption =
  | string
  | {
      value?: unknown
      label?: unknown
      title?: unknown
      name?: unknown
      description?: unknown
      detail?: unknown
    }

/** OpenCode 2.3 sends options as { value, label, description }; older or other shapes are read too. */
type FormField = {
  key?: string
  type?: string
  title?: string
  description?: string
  options?: FormOption[]
  choices?: FormOption[]
  enum?: FormOption[]
  multiple?: boolean
  custom?: boolean
}

/** The OpenCode 2 events the bridge reads; payloads per @opencode/client generated types. */
export type BridgeEvent =
  | {
      type: "form.created"
      data: {
        form: {
          id: string
          sessionID: string
          title?: string
          metadata?: { kind?: unknown }
          fields?: FormField[]
        }
      }
    }
  | {
      type: "form.replied" | "form.cancelled"
      data: { id: string; sessionID: string }
    }
  | {
      type: "permission.asked"
      data: {
        id: string
        sessionID: string
        action: string
        resources?: string[]
        message?: string
      }
    }
  | {
      type: "permission.replied"
      data: { requestID: string; sessionID: string }
    }
  | {
      type: "session.inbox.enqueued"
      data: { sessionID: string; item?: { type?: string } }
    }
  | {
      type:
        | "session.execution.started"
        | "session.execution.succeeded"
        | "session.execution.failed"
        | "session.execution.interrupted"
      data: { sessionID: string }
    }
  | { type: "session.renamed"; data: { sessionID: string; title: string } }
  | {
      type: "session.model.selected"
      data: { sessionID: string; model: { id: string } }
    }

const DETAIL_MAX = 60
const THREAD_MAX = 40
const EXPIRY_MS = 24 * 60 * 60 * 1000

const str = (v: unknown) => (typeof v === "string" ? v : undefined)

function option(o: FormOption): { label: string; detail?: string } {
  if (typeof o === "string") return { label: o }
  return {
    label: str(o.label) ?? str(o.title) ?? str(o.name) ?? String(o.value ?? ""),
    detail: str(o.description) ?? str(o.detail),
  }
}

let shapeLogged = false

export function toQuestions(fields: FormField[] = []): Question[] {
  if (!shapeLogged && fields.length) {
    shapeLogged = true
    const first = fields.map((f) => f.options ?? f.choices ?? f.enum)[0]?.[0]
    log("form_shape", {
      fields: fields.map((f) => Object.keys(f ?? {})),
      option:
        first && typeof first === "object" ? Object.keys(first) : typeof first,
    })
  }
  return fields
    .filter((f) => {
      const list = f.options ?? f.choices ?? f.enum
      return (
        f.key &&
        (f.type === "string" ||
          f.type === "multiselect" ||
          (Array.isArray(list) && list.length > 0))
      )
    })
    .map((f) => {
      const opts = (f.options ?? f.choices ?? f.enum ?? []).map(option)
      return {
        key: f.key!,
        header: f.title ?? "",
        text: f.description ?? f.title ?? "",
        options: opts.map((o) => o.label),
        details: opts.map((o) => o.detail ?? ""),
        multiple: f.type === "multiselect" || f.multiple === true,
        custom: f.custom !== false,
      }
    })
}

export function questionBody(qs: Question[]): string {
  const block = (q: Question) => {
    const lines = [q.text]
    q.options.forEach((o, i) => {
      const d = q.details?.[i]
      lines.push(`${i + 1}. ${o}${d ? ` — ${truncate(d, DETAIL_MAX)}` : ""}`)
    })
    return lines.join("\n")
  }
  if (qs.length === 1) return block(qs[0])
  return qs.map((q, i) => `${i + 1}) ${q.header}\n${block(q)}`).join("\n\n")
}

/** A title already in brackets is left as it is. */
const bracketed = (t: string) => (t.startsWith("[") ? t : `[${t}]`)

const no = (text: string): Outcome => ({ ok: false, text })

export type BridgeStatus = {
  channels: Array<{ id: string; enabled: boolean } & ConnectorStatus>
  pending: number
}

export class Bridge {
  private readonly controllers = new Map<string, AbortController>()

  private readonly cfg: Config
  private readonly host: Host
  private readonly channels: Connector[]
  private readonly store: PendingStore
  private readonly router: Router
  private readonly now: () => number
  private readonly tel: Telemetry
  /** The last state shown per top-level session, and when its run started. */
  private readonly states = new Map<
    string,
    { state: SessionState["state"]; at: number; started?: number }
  >()

  constructor(
    cfg: Config,
    host: Host,
    channels: Connector[],
    store: PendingStore,
    router: Router,
    now: () => number = Date.now,
    tel: Telemetry = noTelemetry(),
  ) {
    this.tel = tel
    this.cfg = cfg
    this.host = host
    this.channels = channels
    this.store = store
    this.router = router
    this.now = now
  }

  /** Every connector, enabled or not. */
  connectors(): readonly Connector[] {
    return this.channels
  }

  /** Starts the reply subscription of every enabled channel; returns at once. */
  start(): void {
    for (const ch of this.channels) if (ch.enabled) this.run(ch)
  }

  private run(ch: Connector): void {
    if (this.controllers.has(ch.id)) return
    const open = this.store.list().filter((p) => p.state === "pending")
    const ac = new AbortController()
    this.controllers.set(ch.id, ac)
    ch.start(
      (m) => this.onInbound(ch, m),
      ac.signal,
      open.length ? Math.min(...open.map((p) => p.askedAt)) : undefined,
    )
  }

  /** Turns a channel on or off now. False when there is no such channel. */
  setEnabled(id: string, on: boolean): boolean {
    const ch = this.channels.find((c) => c.id === id)
    if (!ch) return false
    ch.enabled = on
    if (on) this.run(ch)
    else {
      this.controllers.get(id)?.abort()
      this.controllers.delete(id)
    }
    return true
  }

  status(): BridgeStatus {
    return {
      channels: this.channels.map((c) => ({
        id: c.id,
        enabled: c.enabled,
        ...c.status(),
      })),
      pending: this.store.list().filter((p) => p.state === "pending").length,
    }
  }

  /** A notice to every enabled channel; which of them took it. */
  async test(): Promise<Array<{ id: string; ok: boolean }>> {
    const text = "Test push: this channel works."
    const f = this.fmt("notice", { text })
    const to = this.active()
    const { ok } = await this.dispatch(
      "notice",
      to,
      (ch) => ({
        ...f,
        ...this.card(ch, "notice", undefined, () => ({ kind: "notice", text })),
      }),
      {},
    )
    return to.map((c) => ({ id: c.id, ok: ok[c.id] === true }))
  }

  /** Starts pairing a connector; the span lasts until it is paired or the code expires. */
  async pair(c: Connector): Promise<Pairing | undefined> {
    if (!c.capabilities.pairing || !c.pair) return undefined
    const span = this.tel.begin("oob.pair", {
      attrs: { "connector.type": c.type },
    })
    try {
      const p = await c.pair()
      void p.done.then((ok) => span.end({ ok }, ok ? undefined : "expired"))
      return p
    } catch (err) {
      span.end({ ok: false }, (err as Error).name)
      log("pair_error", { channel: c.id, message: (err as Error).message })
      return undefined
    }
  }

  async stop(): Promise<void> {
    for (const ac of this.controllers.values()) ac.abort()
    this.controllers.clear()
    await this.store.flush()
  }

  async onEvent(e: BridgeEvent): Promise<void> {
    try {
      switch (e.type) {
        case "form.created":
          return await this.onForm(e.data.form)
        case "form.replied":
        case "form.cancelled":
          return await this.closed(
            e.data.id,
            e.type === "form.replied" ? "Answered in the TUI" : "Cancelled",
          )
        case "permission.asked":
          return await this.onPermission(e.data)
        case "permission.replied":
          return await this.closed(e.data.requestID, "Answered in the TUI")
        case "session.inbox.enqueued":
          if (e.data.item?.type === "user") this.router.touch()
          return
        case "session.execution.started":
          return await this.onState(e.data.sessionID, "working")
        case "session.execution.interrupted":
          return await this.onState(e.data.sessionID, "idle")
        case "session.execution.succeeded":
        case "session.execution.failed":
          return await this.onFinished(
            e.data.sessionID,
            e.type === "session.execution.failed",
          )
        case "session.renamed":
          return await this.onState(e.data.sessionID, undefined, {
            title: e.data.title,
          })
        case "session.model.selected":
          return await this.onState(e.data.sessionID, undefined, {
            model: e.data.model.id,
          })
      }
    } catch (err) {
      log("event_error", { type: e.type, message: (err as Error).message })
    }
  }

  private active(): Connector[] {
    return this.channels.filter((c) => c.enabled)
  }

  /** A channel never throws by contract; a bug in one must not stop the others. */
  private async safely<T>(
    ch: Connector,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn()
    } catch (err) {
      log("channel_error", { channel: ch.id, message: (err as Error).message })
      return undefined
    }
  }

  /** Root facts when the session routes, else undefined. */
  private async routed(sessionID: string) {
    const rootID = this.host.root(sessionID)
    const [root, asking] = await Promise.all([
      this.host.session(rootID),
      rootID === sessionID ? undefined : this.host.session(sessionID),
    ])
    const facts = { id: rootID, agent: root?.agent, directory: root?.directory }
    const decision = await this.router.decide(facts)
    const to = decision.routes ? this.targets(rootID) : []
    this.tel
      .begin("oob.route", {
        session: rootID,
        attrs: {
          mode: decision.mode,
          reason: decision.reason,
          routes: decision.routes,
          channel: this.router.channel(rootID) ?? this.cfg.defaultChannel,
          targets: to.length,
        },
      })
      .end()
    if (!decision.routes) return undefined
    const project = root?.directory ? basename(root.directory) : "opencode"
    const who = asking ?? root
    const vars: Vars = {
      project,
      agent: who?.agent ?? "agent",
      subagent: rootID === sessionID ? "" : (who?.agent ?? "agent"),
      session: redact(root?.title ?? rootID, this.cfg.redact),
      sessionID: rootID,
      directory: root?.directory ?? "",
    }
    const session = {
      id: rootID,
      project,
      agent: root?.agent,
      name:
        this.cfg.redact.mode === "title"
          ? project
          : `${project} · ${vars.session}`,
    }
    const title =
      this.cfg.redact.mode === "title"
        ? undefined
        : redact(root?.title ?? "", this.cfg.redact)
    return { rootID, root, facts, vars, session, to, project, title }
  }

  /** Enabled channels a session's pushes go to: its own choice, else the default. */
  private targets(rootID: string): Connector[] {
    const pick = this.router.channel(rootID) ?? this.cfg.defaultChannel
    return this.active().filter((c) => pick === "all" || c.id === pick)
  }

  /** What a connector can use of the session and the question: the rest is dropped, so it degrades to plain text. */
  private shape(
    ch: Connector,
    session: NonNullable<Push["session"]>,
    prompt?: NonNullable<Push["prompt"]>,
  ): Pick<Push, "session" | "prompt"> {
    const cap = ch.capabilities
    const buttons =
      prompt &&
      cap.buttons &&
      prompt.questions.every((q) => !q.multiple || cap.multiselect)
    return {
      session: cap.threads ? session : undefined,
      prompt: buttons ? prompt : undefined,
    }
  }

  /**
   * Sends one push to the given connectors under an `oob.push` span, one child
   * span per connector. With `refs` it marks earlier messages instead: edited
   * where the connector can, a follow-up message where it cannot.
   */
  private async dispatch(
    kind: Kind,
    to: Connector[],
    build: (ch: Connector) => Push,
    o: {
      root?: string
      pending?: string
      refs?: Record<string, string>
      /** Where a follow-up goes when an edit fails. */
      session?: { id: string; name: string }
    },
  ): Promise<{ refs: Record<string, string>; ok: Record<string, boolean> }> {
    const span = this.tel.begin("oob.push", {
      session: o.root,
      attrs: { "push.kind": kind, "pending.id": o.pending },
    })
    const refs: Record<string, string> = {}
    const ok: Record<string, boolean> = {}
    await Promise.all(
      to.map(async (ch) => {
        const old = o.refs?.[ch.id]
        // Nothing reached that connector, so there is nothing to mark.
        if (o.refs && old === undefined) return
        const edit = old !== undefined && ch.capabilities.edit && ch.update
        const stats: SendStats = {}
        const attrs = { "connector.type": ch.type, "push.kind": kind }
        const child = this.tel.begin(edit ? "oob.update" : "oob.send", {
          session: o.root,
          parent: span.id,
          attrs: { ...attrs, "pending.id": o.pending },
        })
        const push = { ...build(ch), stats }
        let res = await this.safely(ch, async () =>
          edit ? ch.update!(old, push) : ch.send(push),
        )
        if (edit && res === false) {
          // The message could not be rewritten: say it in a new one.
          log("edit_failed", { channel: ch.id, pending: o.pending })
          res = await this.safely(ch, () =>
            ch.send({
              ...push,
              session: ch.capabilities.threads ? o.session : undefined,
            }),
          )
        }
        const sent = res !== undefined && res !== false
        ok[ch.id] = sent
        if (typeof res === "string") refs[ch.id] = res
        this.tel.count(sent ? "oob.pushes" : "oob.push.errors", attrs)
        child.end(
          { ok: sent, http_status: stats.httpStatus, retries: stats.retries },
          sent ? undefined : "send-failed",
        )
      }),
    )
    span.end({ targets: to.length })
    return { refs, ok }
  }

  /** Records where a prompt's messages went. */
  private remember(p: Pending, refs: Record<string, string>) {
    if (Object.keys(refs).length)
      this.store.update(p.id, {
        refs: { ...this.store.get(p.id)?.refs, ...refs },
      })
  }

  private pendingGauge() {
    this.tel.gauge(
      "oob.pending",
      {},
      this.store.list().filter((p) => p.state === "pending").length,
    )
  }

  /** Structured content for a connector that can render it itself, unless the user wrote that kind's text. */
  private card(
    ch: Connector,
    kind: Kind,
    facts: SessionFacts | undefined,
    build: () => Card,
  ): Pick<Push, "card"> {
    if (
      !ch.capabilities.rich ||
      isCustomized(kind, this.cfg.messages, this.cfg.profiles, facts)
    )
      return {}
    return { card: build() }
  }

  private cardQuestions(qs: Question[]): CardQuestion[] {
    const hidden = this.cfg.redact.mode === "title"
    const r = (t: string) => redact(t, this.cfg.redact)
    return qs.map((q) => ({
      header: q.header ? r(q.header) : undefined,
      text: r(q.text),
      options: hidden
        ? []
        : q.options.map((label, i) => ({
            label,
            detail: q.details?.[i]
              ? truncate(r(q.details[i]), DETAIL_MAX)
              : undefined,
          })),
      multiple: q.multiple,
      custom: q.custom,
    }))
  }

  private async onForm(
    form: Extract<BridgeEvent, { type: "form.created" }>["data"]["form"],
  ) {
    if (form.metadata?.kind !== "question") return
    const questions = toQuestions(form.fields)
    if (questions.length === 0) return
    const r = await this.routed(form.sessionID)
    if (!r) return
    const id = this.store.newId()
    const qvars = (hint: string): Vars => ({
      ...r.vars,
      id,
      thread: r.title ? `${bracketed(truncate(r.title, THREAD_MAX))}\n` : "",
      body: redact(questionBody(questions), this.cfg.redact),
      hint,
    })
    const p = this.store.put({
      id,
      kind: "question",
      requestID: form.id,
      sessionID: form.sessionID,
      rootSessionID: r.rootID,
      title: this.fmt("question", qvars(""), r.facts).title,
      questions,
      askedAt: this.now(),
      state: "pending",
    })
    this.pendingGauge()
    const sent = await this.dispatch(
      "question",
      r.to,
      (ch) => ({
        ...this.fmt("question", qvars(ch.hint(id, questions)), r.facts),
        ...this.shape(ch, r.session, { id, questions }),
        ...this.card(ch, "question", r.facts, () => ({
          kind: "question",
          agent: r.vars.agent ?? "agent",
          project: r.project,
          session: r.title,
          questions: this.cardQuestions(questions),
        })),
      }),
      { root: r.rootID, pending: id },
    )
    this.remember(p, sent.refs)
    // Answered in the TUI while the message was still being sent.
    const now = this.store.get(id)
    if (now && now.state !== "pending" && now.answeredBy === "tui")
      await this.markAnswered(now, {
        outcome: now.state === "cancelled" ? "cancelled" : "answered",
        via: "TUI",
      })
  }

  private async onPermission(
    d: Extract<BridgeEvent, { type: "permission.asked" }>["data"],
  ) {
    const r = await this.routed(d.sessionID)
    if (!r) return
    const id = this.store.newId()
    const detail = [`${d.action}: ${(d.resources ?? []).join(", ")}`, d.message]
      .filter(Boolean)
      .join("\n")
    const f = this.fmt(
      "permission",
      {
        ...r.vars,
        id,
        action: d.action,
        resources: (d.resources ?? []).join(", "),
        detail: redact(detail, this.cfg.redact),
      },
      r.facts,
    )
    const p = this.store.put({
      id,
      kind: "permission",
      requestID: d.id,
      sessionID: d.sessionID,
      rootSessionID: r.rootID,
      title: f.title,
      askedAt: this.now(),
      state: "pending",
    })
    this.pendingGauge()
    const sent = await this.dispatch(
      "permission",
      r.to,
      (ch) => ({
        ...f,
        ...this.shape(ch, r.session),
        ...this.card(ch, "permission", r.facts, () => ({
          kind: "permission",
          agent: r.vars.agent ?? "agent",
          project: r.project,
          session: r.title,
          detail: redact(detail, this.cfg.redact),
        })),
      }),
      { root: r.rootID, pending: id },
    )
    this.remember(p, sent.refs)
  }

  /** Shows a session's state on the connectors that keep a live view of it. */
  private async track(
    r: NonNullable<Awaited<ReturnType<Bridge["routed"]>>>,
    state: SessionState["state"] | undefined,
    patch: { title?: string; model?: string } = {},
  ) {
    const prev = this.states.get(r.rootID)
    const now = this.now()
    const next = {
      state: state ?? prev?.state ?? "idle",
      at: state ? now : (prev?.at ?? now),
      started: state === "working" ? now : prev?.started,
    }
    this.states.set(r.rootID, next)
    const title =
      patch.title === undefined
        ? r.title
        : this.cfg.redact.mode === "title"
          ? undefined
          : redact(patch.title, this.cfg.redact)
    const s: SessionState = {
      id: r.rootID,
      name: title ? `${r.project} · ${title}` : r.session.name,
      project: r.project,
      title,
      agent: r.root?.agent,
      model: patch.model ?? r.root?.model,
      state: next.state,
      at: next.at,
    }
    await Promise.all(
      r.to.map((c) =>
        c.track ? this.safely(c, () => c.track!(s)) : undefined,
      ),
    )
    return next
  }

  private async onState(
    sessionID: string,
    state?: SessionState["state"],
    patch?: { title?: string; model?: string },
  ) {
    if (this.host.root(sessionID) !== sessionID) return
    const r = await this.routed(sessionID)
    if (r) await this.track(r, state, patch)
  }

  private async onFinished(sessionID: string, failed: boolean) {
    if (this.host.root(sessionID) !== sessionID) return
    const r = await this.routed(sessionID)
    if (!r) return
    const kind = failed ? "failed" : "finished"
    const st = await this.track(r, failed ? "failed" : "idle")
    const duration =
      st.started === undefined
        ? undefined
        : formatDuration(this.now() - st.started)
    const f = this.fmt(kind, r.vars, r.facts)
    await this.dispatch(
      kind,
      r.to.filter((c) => c.notify?.[kind] ?? true),
      (c) => ({
        ...f,
        ...this.shape(c, r.session),
        ...this.card(c, kind, r.facts, () => ({
          kind,
          project: r.project,
          session: r.title,
          duration,
        })),
      }),
      { root: r.rootID },
    )
  }

  /** A prompt was answered or cancelled in OpenCode. */
  private async closed(requestID: string, note: string) {
    const p = this.store.byRequest(requestID)
    if (!p) return this.router.touch()
    if (p.state !== "pending") return
    this.router.touch()
    const cancelled = note === "Cancelled"
    this.store.update(p.id, {
      state: cancelled ? "cancelled" : "answered",
      answeredBy: "tui",
      answeredAt: this.now(),
    })
    this.pendingGauge()
    if (!cancelled) this.answered(p, "tui")
    await this.markAnswered(p, {
      outcome: cancelled ? "cancelled" : "answered",
      via: "TUI",
    })
  }

  /** Counts an answer and how long the prompt waited for it. */
  private answered(p: Pending, by: "phone" | "tui", ch?: Connector) {
    const attrs = { answered_by: by, "connector.type": ch?.type }
    this.tel.count("oob.answers", attrs)
    this.tel.record("oob.answer.latency_ms", attrs, this.now() - p.askedAt)
  }

  /** Marks the prompt's message on every connector that carries it. */
  private async markAnswered(
    p: Pending,
    o: { outcome: "answered" | "cancelled"; via: string; answer?: string },
  ) {
    const note =
      o.outcome === "cancelled"
        ? "Cancelled"
        : o.via === "TUI"
          ? "Answered in the TUI"
          : `Answered from ${o.via}: ${o.answer}`
    const f = this.fmt("closed", { id: p.id, title: p.title, note })
    const time = clock(this.now())
    const quote = redact(
      (p.questions ?? []).map((q) => q.text).join(" / ") || p.title,
      this.cfg.redact,
    )
    await this.dispatch(
      "closed",
      this.active(),
      (ch) => ({
        ...f,
        ...this.card(ch, "closed", undefined, () => ({
          kind: "closed",
          outcome: o.outcome,
          answer: o.answer,
          via: o.via,
          time,
          quote,
        })),
      }),
      {
        root: p.rootSessionID,
        pending: p.id,
        refs: p.refs ?? {},
        session: { id: p.rootSessionID, name: p.title },
      },
    )
  }

  private fmt(kind: Kind, vars: Vars, facts?: SessionFacts) {
    return format(kind, vars, this.cfg.messages, this.cfg.profiles, facts)
  }

  private async onInbound(
    ch: Connector,
    m: Inbound,
  ): Promise<Outcome | undefined> {
    const span = this.tel.begin("oob.inbound", {
      attrs: { kind: m.kind, "connector.type": ch.type },
    })
    const info: { outcome: string; pending?: Pending } = { outcome: "ignored" }
    try {
      const out = await this.apply(ch, m, info)
      if (out && !out.ok && !m.inline) {
        const f = this.fmt("notice", { text: out.text })
        await this.dispatch(
          "notice",
          [ch],
          () => ({
            ...f,
            ...this.card(ch, "notice", undefined, () => ({
              kind: "notice",
              text: out.text,
            })),
          }),
          {
            root: info.pending?.rootSessionID,
            pending: info.pending?.id,
          },
        )
      }
      if (info.outcome !== "applied" && info.outcome !== "ignored")
        this.tel.count("oob.inbound.rejected", {
          "connector.type": ch.type,
          reason: info.outcome,
        })
      span.setSession(info.pending?.rootSessionID)
      span.end(
        { outcome: info.outcome, "pending.id": info.pending?.id },
        out && !out.ok ? info.outcome : undefined,
      )
      return out
    } catch (err) {
      log("inbound_error", { message: (err as Error).message })
      span.end({ outcome: "error" }, "error")
      return undefined
    }
  }

  private async apply(
    ch: Connector,
    m: Inbound,
    info: { outcome: string; pending?: Pending },
  ): Promise<Outcome | undefined> {
    // Sending text into a session is not built: nothing is applied.
    if (m.kind !== "answer") {
      log("inbound_ignored", { connector: ch.id, kind: m.kind })
      return undefined
    }
    let id: string
    let reply: Reply
    if (m.pendingId) {
      id = m.pendingId
      reply =
        m.choice !== undefined
          ? { id, choice: m.choice }
          : { id, text: m.text, literal: m.literal }
    } else if (m.replyTo) {
      // A reply to the message itself; one that answers nothing we track is not ours.
      const target = this.store.byRef(ch.id, m.replyTo)
      if (!target) return undefined
      id = target.id
      reply = { id, text: m.text }
    } else return undefined
    const p = this.store.get(id)
    info.pending = p
    if (!p || this.now() - p.askedAt > EXPIRY_MS) {
      info.outcome = "expired"
      return no(`#${id}: unknown or expired id, not applied.`)
    }
    if (p.state !== "pending") {
      // A reply older than the answer is a replay after reconnect, not a second answer.
      if (m.id === p.replyID) return undefined
      if (
        p.answeredAt !== undefined &&
        m.time < Math.floor(p.answeredAt / 1000)
      )
        return undefined
      info.outcome = "duplicate"
      return no(`#${p.id}: already answered, not applied.`)
    }
    if (p.kind === "permission") {
      info.outcome = "permission-refused"
      return no(
        `#${p.id}: permissions can only be answered in the OpenCode TUI.`,
      )
    }
    const answer = resolveAnswer(p.questions ?? [], reply)
    if (!answer) {
      info.outcome = "unreadable"
      return no(
        `#${p.id}: could not read that answer. ${ch.hint(p.id, p.questions ?? [])}`,
      )
    }
    // Claimed before the await: the first answer wins, from either side.
    this.store.update(p.id, {
      state: "answered",
      answeredBy: "phone",
      answeredVia: ch.id,
      answeredAt: this.now(),
      replyID: m.id,
    })
    this.pendingGauge()
    try {
      await this.host.replyForm(p.sessionID, p.requestID, answer)
    } catch (err) {
      log("reply_error", { id: p.id, message: (err as Error).message })
      this.store.update(p.id, { state: "failed" })
      this.pendingGauge()
      info.outcome = "failed"
      return no(`#${p.id}: not applied (already answered or expired).`)
    }
    const given = redact(
      Object.values(answer).flat().join(" | "),
      this.cfg.redact,
    )
    info.outcome = "applied"
    this.answered(p, "phone", ch)
    await this.markAnswered(p, {
      outcome: "answered",
      via: ch.id,
      answer: given,
    })
    return { ok: true, text: `Answered: ${given}` }
  }
}
