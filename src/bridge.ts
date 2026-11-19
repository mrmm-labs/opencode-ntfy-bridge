/**
 * The bridge: OpenCode events in, ntfy pushes out, ntfy replies back in.
 *
 * Questions (tier 1) can be answered from ntfy. Permission prompts are tier 3:
 * push only. There is deliberately no code path that replies to a permission.
 */
import { basename } from "node:path"

import type { Config } from "./config.ts"
import { redact } from "./filter.ts"
import {
  parseReply,
  resolveAnswer,
  type Answer,
  type Question,
} from "./inbound.ts"
import { log } from "./logger.ts"
import type { HttpAction, Incoming, Ntfy } from "./ntfy.ts"
import type { Pending, PendingStore } from "./pending.ts"
import type { Router } from "./routing.ts"

export type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  directory?: string
  title?: string
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
      type: "session.execution.succeeded" | "session.execution.failed"
      data: { sessionID: string }
    }

const MAX_BUTTONS = 3
const LABEL_MAX = 24
const DETAIL_MAX = 60
const THREAD_MAX = 40
const EXPIRY_MS = 24 * 60 * 60 * 1000

const str = (v: unknown) => (typeof v === "string" ? v : undefined)

export const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s

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

const buttons = (qs: Question[]) =>
  qs.length === 1 &&
  !qs[0].multiple &&
  qs[0].options.length > 0 &&
  qs[0].options.length <= MAX_BUTTONS

export function replyHint(id: string, qs: Question[], inTopic: string): string {
  const to = `to topic ${inTopic}`
  if (qs.length !== 1) return `Post \`#${id} <answer 1> | <answer 2> …\` ${to}`
  if (qs[0].multiple) return `Post \`#${id} 1,3\` (numbers) ${to}`
  if (buttons(qs)) return `Tap a button, or post \`#${id} <n or text>\` ${to}`
  return `Reply by number: post \`#${id} <n or text>\` ${to}`
}

/** The question push: body and buttons. */
export function renderQuestion(
  cfg: Pick<Config, "server" | "topics" | "redact">,
  id: string,
  questions: Question[],
  threadTitle?: string,
): { message: string; actions?: HttpAction[] } {
  const thread = threadTitle ? `[${truncate(threadTitle, THREAD_MAX)}]\n` : ""
  const actions: HttpAction[] | undefined = buttons(questions)
    ? questions[0].options.map((label, i) => ({
        action: "http",
        label: truncate(label, LABEL_MAX),
        url: `${cfg.server}/${cfg.topics.in}`,
        method: "POST",
        body: JSON.stringify({ id, choice: i + 1 }),
        clear: true,
      }))
    : undefined
  return {
    message: `${thread}${redact(questionBody(questions), cfg.redact)}\n\n${replyHint(id, questions, cfg.topics.in)}`,
    actions,
  }
}

export class Bridge {
  private readonly abort = new AbortController()

  private readonly cfg: Config
  private readonly host: Host
  private readonly ntfy: Ntfy
  private readonly store: PendingStore
  private readonly router: Router
  private readonly now: () => number

  constructor(
    cfg: Config,
    host: Host,
    ntfy: Ntfy,
    store: PendingStore,
    router: Router,
    now: () => number = Date.now,
  ) {
    this.cfg = cfg
    this.host = host
    this.ntfy = ntfy
    this.store = store
    this.router = router
    this.now = now
  }

  /** Starts the reply subscription; returns at once. */
  start(): void {
    const open = this.store.list().filter((p) => p.state === "pending")
    // After a restart, replay the in topic from the oldest unanswered prompt.
    const since = open.length
      ? String(Math.floor(Math.min(...open.map((p) => p.askedAt)) / 1000))
      : undefined
    void this.ntfy.subscribe(
      (m) => void this.onInbound(m),
      this.abort.signal,
      since,
    )
  }

  async stop(): Promise<void> {
    this.abort.abort()
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
        case "session.execution.succeeded":
        case "session.execution.failed":
          return await this.onFinished(
            e.data.sessionID,
            e.type === "session.execution.failed",
          )
      }
    } catch (err) {
      log("event_error", { type: e.type, message: (err as Error).message })
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
    if (!(await this.router.routes(facts))) return undefined
    const project = root?.directory ? basename(root.directory) : "opencode"
    return { rootID, root, asking: asking ?? root, project }
  }

  private async onForm(
    form: Extract<BridgeEvent, { type: "form.created" }>["data"]["form"],
  ) {
    if (form.metadata?.kind !== "question") return
    const questions = toQuestions(form.fields)
    if (questions.length === 0) return
    const r = await this.routed(form.sessionID)
    if (!r) return
    const agent = r.asking?.agent ?? "agent"
    const id = this.store.newId()
    const title = `${r.project} · ${agent} asks`
    const p = this.store.put({
      id,
      kind: "question",
      requestID: form.id,
      sessionID: form.sessionID,
      rootSessionID: r.rootID,
      title,
      questions,
      askedAt: this.now(),
      state: "pending",
    })
    const { message, actions } = renderQuestion(
      this.cfg,
      id,
      questions,
      r.root?.title,
    )
    const msgID = await this.ntfy.publish({
      title,
      message,
      tags: tags("question", form.sessionID !== r.rootID ? agent : undefined),
      priority: 4,
      actions,
    })
    if (msgID) this.store.update(p.id, { ntfyMessageID: msgID })
  }

  private async onPermission(
    d: Extract<BridgeEvent, { type: "permission.asked" }>["data"],
  ) {
    const r = await this.routed(d.sessionID)
    if (!r) return
    const agent = r.asking?.agent ?? "agent"
    const id = this.store.newId()
    const title = `${r.project} · ${agent} needs permission`
    const p = this.store.put({
      id,
      kind: "permission",
      requestID: d.id,
      sessionID: d.sessionID,
      rootSessionID: r.rootID,
      title,
      askedAt: this.now(),
      state: "pending",
    })
    const detail = [`${d.action}: ${(d.resources ?? []).join(", ")}`, d.message]
      .filter(Boolean)
      .join("\n")
    const msgID = await this.ntfy.publish({
      title,
      message: `${redact(detail, this.cfg.redact)}\n\nAnswer in the OpenCode TUI. Permissions are never applied from ntfy.`,
      tags: tags("lock", d.sessionID !== r.rootID ? agent : undefined),
      priority: 4,
    })
    if (msgID) this.store.update(p.id, { ntfyMessageID: msgID })
  }

  private async onFinished(sessionID: string, failed: boolean) {
    if (this.host.root(sessionID) !== sessionID) return
    const r = await this.routed(sessionID)
    if (!r) return
    await this.ntfy.publish({
      title: `${r.project} · ${failed ? "session failed" : "session finished"}`,
      message: redact(r.root?.title ?? sessionID, this.cfg.redact),
      tags: [failed ? "x" : "white_check_mark"],
      priority: 2,
    })
  }

  /** A prompt was answered or cancelled in OpenCode. */
  private async closed(requestID: string, note: string) {
    const p = this.store.byRequest(requestID)
    if (!p) return this.router.touch()
    if (p.state !== "pending") return
    this.router.touch()
    this.store.update(p.id, {
      state: note === "Cancelled" ? "cancelled" : "answered",
      answeredBy: "tui",
      answeredAt: this.now(),
    })
    // Nothing reached the phone, so there is nothing to mark.
    if (p.ntfyMessageID) await this.update(p, note)
  }

  private update(p: Pending, message: string) {
    return this.ntfy.publish({
      title: p.title,
      message,
      tags: ["white_check_mark"],
      priority: 1,
      sequence_id: p.ntfyMessageID,
    })
  }

  private notice(message: string) {
    return this.ntfy.publish({
      title: "ntfy bridge",
      message,
      priority: 2,
      tags: ["warning"],
    })
  }

  async onInbound(m: Incoming): Promise<void> {
    try {
      const reply = parseReply(m.message)
      if (!reply) return
      const p = this.store.get(reply.id)
      if (!p || this.now() - p.askedAt > EXPIRY_MS)
        return void (await this.notice(
          `#${reply.id}: unknown or expired id, not applied.`,
        ))
      if (p.state !== "pending") {
        // A reply older than the answer is a replay after reconnect, not a second answer.
        if (m.id === p.replyID) return
        if (
          p.answeredAt !== undefined &&
          m.time < Math.floor(p.answeredAt / 1000)
        )
          return
        return void (await this.notice(
          `#${p.id}: already answered, not applied.`,
        ))
      }
      if (p.kind === "permission")
        return void (await this.notice(
          `#${p.id}: permissions can only be answered in the OpenCode TUI.`,
        ))
      const answer = resolveAnswer(p.questions ?? [], reply)
      if (!answer)
        return void (await this.notice(
          `#${p.id}: could not read that answer. ${replyHint(p.id, p.questions ?? [], this.cfg.topics.in)}`,
        ))
      // Claimed before the await: the first answer wins, from either side.
      this.store.update(p.id, {
        state: "answered",
        answeredBy: "phone",
        answeredAt: this.now(),
        replyID: m.id,
      })
      try {
        await this.host.replyForm(p.sessionID, p.requestID, answer)
      } catch (err) {
        log("reply_error", { id: p.id, message: (err as Error).message })
        this.store.update(p.id, { state: "failed" })
        return void (await this.notice(
          `#${p.id}: not applied (already answered or expired).`,
        ))
      }
      await this.update(
        p,
        `Answered from ntfy: ${redact(Object.values(answer).flat().join(" | "), this.cfg.redact)}`,
      )
    } catch (err) {
      log("inbound_error", { message: (err as Error).message })
    }
  }
}

function tags(kind: string, agent?: string): string[] {
  return agent ? [kind, agent] : [kind]
}
