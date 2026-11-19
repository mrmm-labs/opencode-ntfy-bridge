/**
 * Telegram as a connector, over the Bot API with long polling: the plugin only
 * makes outgoing HTTPS requests and exposes nothing.
 *
 * In a forum supergroup each top-level session gets its own topic. Questions
 * carry inline buttons (toggles plus Done for multiple choice).
 * Several questions in one prompt, or more than MAX_BUTTONS options, are
 * answered by replying to the message with numbers or text. Only the paired
 * chat is heard; everything else is dropped unread.
 */
import { randomInt } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { filterSecrets } from "../filter.ts"
import { parseReply, type Question } from "../inbound.ts"
import { log } from "../logger.ts"
import type { Telemetry } from "../otel.ts"
import {
  lazyToken,
  parseTokenSource,
  TOKEN_ERROR,
  type TokenSource,
} from "../token.ts"
import { sleep, truncate, URL_RE } from "../util.ts"
import type {
  Capabilities,
  Connector,
  ConnectorStatus,
  ConnectorType,
  Inbound,
  OnInbound,
  Outcome,
  Pairing,
  Push,
  SendStats,
} from "./types.ts"

const MAX_BUTTONS = 10
const LABEL_MAX = 40
const TEXT_MAX = 3500
const POLL_SECONDS = 30
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const PAIR_TTL_MS = 10 * 60_000
const TOAST_MAX = 190

export type TelegramOptions = {
  /** Instance name; defaults to "telegram". */
  name?: string
  tel?: Telemetry
  token: () => Promise<string | undefined>
  /** The paired chat. Unset until `pair()` completes. */
  chatId?: string
  apiBase?: string
  /** Where the update offset is kept across restarts. */
  offsetFile?: string
  /** Where session topics of a forum chat are remembered across restarts. */
  topicsFile?: string
  /** Called with the chat id once pairing succeeds, to store it. */
  onPaired?: (chatId: string) => void
  fetch?: typeof fetch
  /** Delays in ms after a failed poll: first and cap. */
  backoff?: { min: number; max: number }
  pollSeconds?: number
  pairTtlMs?: number
  /** How long a button tap waits for its outcome before the toast goes out anyway. */
  toastAfterMs?: number
}

type Update = {
  update_id: number
  message?: {
    message_id: number
    date: number
    text?: string
    chat: { id: number }
    message_thread_id?: number
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    data?: string
    message?: { message_id: number; chat: { id: number } }
  }
}

type Markup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function render(push: Push): string {
  const title = push.title
    ? `<b>${esc(truncate(filterSecrets(push.title), 300))}</b>\n`
    : ""
  return `${title}${esc(truncate(filterSecrets(push.message), TEXT_MAX))}`
}

const buttonable = (qs: Question[]) =>
  qs.length === 1 &&
  qs[0].options.length > 0 &&
  qs[0].options.length <= MAX_BUTTONS

export class TelegramConnector implements Connector {
  readonly type = "telegram"
  readonly capabilities: Capabilities = {
    buttons: true,
    edit: true,
    multiselect: true,
    threads: true,
    pairing: true,
    // Sending prompts into sessions from a chat is not built yet.
    inboundPrompt: false,
  }
  readonly id: string
  enabled: boolean

  private chatId: string | undefined
  private connected: boolean | undefined
  private lastError: string | undefined
  private onInbound: OnInbound | undefined
  private signal: AbortSignal | undefined
  private polling = false
  private offset: number | undefined
  /** Whether the paired chat is a forum; undefined until asked. */
  private forum: boolean | undefined
  private topics: Map<string, number> | undefined
  private readonly topicJobs = new Map<string, Promise<number | undefined>>()
  private pairing:
    | { code: string; finish: (chatId: string | undefined) => void }
    | undefined
  /** Multiple-choice prompts with a keyboard: the options and what is ticked. */
  private readonly prompts = new Map<
    string,
    { options: string[]; selected: Set<number>; ref?: string }
  >()

  private readonly opts: TelegramOptions
  private readonly fetch: typeof fetch

  constructor(opts: TelegramOptions, enabled = true) {
    this.opts = opts
    this.id = opts.name ?? "telegram"
    this.enabled = enabled
    this.chatId = opts.chatId
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  start(onInbound: OnInbound, signal: AbortSignal): void {
    this.onInbound = onInbound
    this.signal = signal
    this.poll()
  }

  paired(): boolean {
    return this.chatId !== undefined
  }

  /** Adopts a chat chosen outside this process, such as a stored setting. */
  setChat(chatId: string | undefined): void {
    this.chatId = chatId
    this.forum = undefined
  }

  status(): ConnectorStatus {
    return {
      connected: this.connected,
      lastError: this.lastError ?? (this.chatId ? undefined : "not paired"),
    }
  }

  hint(id: string, qs: Question[]): string {
    if (qs.length !== 1)
      return `Reply to this message with one answer per question, separated by | (for example: 1 | yes | 2,3). Options are numbered.`
    if (qs[0].multiple)
      return buttonable(qs)
        ? `Tick options, then tap Done. Or reply with numbers, like 1,3.`
        : `Reply to this message with numbers, like 1,3.`
    if (buttonable(qs))
      return `Tap a button, or reply to this message with a number or text.`
    return `Reply to this message with a number or text (or send "#${id} <answer>").`
  }

  async send(push: Push): Promise<string | undefined> {
    if (!this.chatId) return undefined
    const q = push.prompt
    const live = q && buttonable(q.questions) ? q : undefined
    const multi = live?.questions[0].multiple ? live : undefined
    if (multi)
      this.prompts.set(multi.id, {
        options: multi.questions[0].options,
        selected: new Set(),
      })
    try {
      for (let attempt = 0; ; attempt++) {
        const thread = await this.thread(push.session)
        try {
          const m = await this.call<{ message_id: number }>(
            "sendMessage",
            {
              chat_id: this.chatId,
              message_thread_id: thread,
              text: render(push),
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              disable_notification: (push.priority ?? 3) <= 2,
              reply_markup: live
                ? this.keyboard(
                    live.id,
                    live.questions[0].options,
                    live.questions[0].multiple,
                    new Set(),
                  )
                : undefined,
            },
            undefined,
            undefined,
            push.stats,
          )
          const ref = String(m.message_id)
          const p = multi && this.prompts.get(multi.id)
          if (p) p.ref = ref
          return ref
        } catch (err) {
          // The topic was deleted in Telegram: make a new one once.
          if (
            thread === undefined ||
            attempt > 0 ||
            !/thread/i.test((err as Error).message)
          )
            throw err
          this.topics?.delete(this.topicKey(push.session!.id))
          await this.saveTopics()
        }
      }
    } catch (err) {
      if (multi) this.prompts.delete(multi.id)
      this.fail(err)
      return undefined
    }
  }

  private topicKey(sessionID: string) {
    return `${this.chatId}:${sessionID}`
  }

  /** The forum topic of a session, created on first use; undefined outside a forum. */
  private async thread(session: Push["session"]): Promise<number | undefined> {
    if (!session || !this.chatId) return undefined
    if (this.forum === undefined) {
      try {
        const chat = await this.call<{ is_forum?: boolean }>("getChat", {
          chat_id: this.chatId,
        })
        this.forum = chat.is_forum === true
      } catch (err) {
        this.fail(err)
        return undefined
      }
    }
    if (!this.forum) return undefined
    this.topics ??= await this.loadTopics()
    const key = this.topicKey(session.id)
    const known = this.topics.get(key)
    if (known !== undefined) return known
    let job = this.topicJobs.get(key)
    if (!job) {
      job = this.createTopic(key, session.name).finally(() =>
        this.topicJobs.delete(key),
      )
      this.topicJobs.set(key, job)
    }
    return job
  }

  private async createTopic(
    key: string,
    name: string,
  ): Promise<number | undefined> {
    try {
      const t = await this.call<{ message_thread_id: number }>(
        "createForumTopic",
        {
          chat_id: this.chatId,
          name: truncate(filterSecrets(name), 128),
        },
      )
      this.topics!.set(key, t.message_thread_id)
      await this.saveTopics()
      return t.message_thread_id
    } catch (err) {
      // Needs the bot to be an admin who may manage topics; the main chat still works.
      this.fail(err)
      return undefined
    }
  }

  private async loadTopics(): Promise<Map<string, number>> {
    const file = this.opts.topicsFile
    if (file) {
      try {
        const v = JSON.parse(await readFile(file, "utf8")) as Record<
          string,
          unknown
        >
        return new Map(
          Object.entries(v).filter(
            (e): e is [string, number] => typeof e[1] === "number",
          ),
        )
      } catch {}
    }
    return new Map()
  }

  private async saveTopics(): Promise<void> {
    const file = this.opts.topicsFile
    if (!file || !this.topics) return
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(Object.fromEntries(this.topics)))
    } catch (err) {
      log("telegram_topics_error", { message: (err as Error).message })
    }
  }

  async update(ref: string, push: Push): Promise<boolean> {
    if (!this.chatId) return false
    for (const [id, p] of this.prompts)
      if (p.ref === ref) this.prompts.delete(id)
    try {
      await this.call(
        "editMessageText",
        {
          chat_id: this.chatId,
          message_id: Number(ref),
          text: render(push),
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        },
        undefined,
        undefined,
        push.stats,
      )
      return true
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  /**
   * Starts pairing: the bot waits for the one-time code to be sent to it, and
   * the chat that sends it becomes the paired chat. The bot takes the code
   * typed as a message or arriving as `/start <code>` from the deep link.
   */
  async pair(): Promise<Pairing> {
    this.pairing?.finish(undefined)
    let code = ""
    for (let i = 0; i < 6; i++)
      code += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]
    let finish!: (chatId: string | undefined) => void
    const done = new Promise<string | undefined>((r) => (finish = r))
    const ttl = this.opts.pairTtlMs ?? PAIR_TTL_MS
    const timer = setTimeout(
      () => this.pairing?.code === code && this.pairing.finish(undefined),
      ttl,
    )
    timer.unref?.()
    const entry = {
      code,
      finish: (chatId: string | undefined) => {
        clearTimeout(timer)
        if (this.pairing === entry) this.pairing = undefined
        finish(chatId)
      },
    }
    this.pairing = entry
    this.poll()
    let username: string | undefined
    try {
      username = (await this.call<{ username?: string }>("getMe", {})).username
    } catch (err) {
      this.fail(err)
    }
    return {
      code,
      link: username ? `https://t.me/${username}?start=${code}` : undefined,
      expiresAt: Date.now() + ttl,
      hint: username
        ? `Open @${username} in Telegram and press Start.`
        : "The bot could not be reached: check the token with /oob status.",
      done: done.then((chat) => chat !== undefined),
    }
  }

  /** A message or tap from a chat that is not the paired one. Only its kind is recorded. */
  private rejected(kind: string): void {
    const attrs = { "connector.type": "telegram", reason: "chat" }
    this.opts.tel?.count("oob.inbound.rejected", attrs)
    this.opts.tel
      ?.begin("oob.inbound", {
        attrs: {
          ...attrs,
          kind: "answer",
          source: kind,
          outcome: "rejected-chat",
        },
      })
      .end({ ok: false })
  }

  private fail(err: unknown): void {
    this.lastError = filterSecrets((err as Error).message)
    log("telegram_error", { message: this.lastError })
  }

  private keyboard(
    id: string,
    options: string[],
    multiple: boolean,
    selected: Set<number>,
  ): Markup {
    const rows = options.map((label, i) => [
      {
        text: truncate(
          multiple && selected.has(i + 1) ? `✓ ${label}` : label,
          LABEL_MAX,
        ),
        callback_data: `${id}:${multiple ? "t" : ""}${i + 1}`,
      },
    ])
    if (multiple) rows.push([{ text: "Done", callback_data: `${id}:d` }])
    return { inline_keyboard: rows }
  }

  /** One Bot API call. Honours 429 `retry_after`; throws on any other failure. */
  private async call<T>(
    method: string,
    body: unknown,
    timeoutMs = 10_000,
    signal?: AbortSignal,
    stats?: SendStats,
  ): Promise<T> {
    const token = await this.opts.token()
    if (!token) throw new Error("no Telegram token")
    const base = this.opts.apiBase ?? "https://api.telegram.org"
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs)
      const res = await this.fetch(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: false,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (stats) stats.httpStatus = res.status
      const json = (await res.json().catch(() => undefined)) as
        | {
            ok?: boolean
            result?: T
            description?: string
            parameters?: { retry_after?: number }
          }
        | undefined
      if (json?.ok) return json.result as T
      const wait = json?.parameters?.retry_after
      if (res.status === 429 && wait !== undefined && attempt < 2) {
        if (stats) stats.retries = attempt + 1
        await sleep(Math.min(wait, 60) * 1000, signal)
        continue
      }
      throw new Error(
        `telegram ${method} failed: HTTP ${res.status} ${json?.description ?? ""}`.trim(),
      )
    }
  }

  private poll(): void {
    const signal = this.signal
    if (this.polling || !signal || signal.aborted) return
    this.polling = true
    void this.loop(signal).finally(() => (this.polling = false))
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const { min, max } = this.opts.backoff ?? { min: 1000, max: 60_000 }
    const seconds = this.opts.pollSeconds ?? POLL_SECONDS
    let delay = min
    this.offset ??= await this.loadOffset()
    while (!signal.aborted && (this.chatId || this.pairing)) {
      try {
        const updates = await this.call<Update[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: seconds,
            allowed_updates: ["message", "callback_query"],
          },
          (seconds + 10) * 1000,
          signal,
        )
        delay = min
        this.connected = true
        this.lastError = undefined
        for (const u of updates) {
          this.offset = u.update_id + 1
          try {
            await this.onUpdate(u)
          } catch (err) {
            log("telegram_update_error", {
              message: filterSecrets((err as Error).message),
            })
          }
        }
        if (updates.length) await this.saveOffset()
      } catch (err) {
        if (signal.aborted) return
        this.connected = false
        this.fail(err)
        this.opts.tel?.count("oob.reconnects", { "connector.type": "telegram" })
        this.opts.tel
          ?.begin("oob.reconnect", {
            attrs: { "connector.type": "telegram", reason: "error" },
          })
          .end({ delay_ms: delay })
        await sleep(delay, signal)
        delay = Math.min(max, delay * 2)
      }
    }
  }

  private async loadOffset(): Promise<number | undefined> {
    if (!this.opts.offsetFile) return undefined
    try {
      const v = JSON.parse(await readFile(this.opts.offsetFile, "utf8")) as {
        offset?: unknown
      }
      return typeof v.offset === "number" ? v.offset : undefined
    } catch {
      return undefined
    }
  }

  private async saveOffset(): Promise<void> {
    const file = this.opts.offsetFile
    if (!file) return
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ offset: this.offset }))
    } catch (err) {
      log("telegram_offset_error", { message: (err as Error).message })
    }
  }

  private async onUpdate(u: Update): Promise<void> {
    if (u.callback_query) return this.onCallback(u.callback_query)
    const m = u.message
    const text = m?.text?.trim()
    if (!m || !text) return
    if (await this.tryPair(String(m.chat.id), text)) return
    if (String(m.chat.id) !== this.chatId) {
      this.rejected("message")
      return log("telegram_ignored", { kind: "message" })
    }
    const base = {
      kind: "answer",
      id: String(u.update_id),
      time: m.date,
      sessionKey:
        m.message_thread_id === undefined
          ? undefined
          : String(m.message_thread_id),
      from: { connector: this.id, chat: String(m.chat.id) },
    } as const
    // An explicit "#id answer" wins over the message replied to.
    const reply = parseReply(text)
    if (reply)
      return void (await this.onInbound?.(
        "choice" in reply
          ? { ...base, pendingId: reply.id, choice: reply.choice, text }
          : { ...base, pendingId: reply.id, text: reply.text },
      ))
    // In a topic, a plain message "replies" to the topic's first message.
    if (
      m.reply_to_message &&
      m.reply_to_message.message_id !== m.message_thread_id
    )
      await this.onInbound?.({
        ...base,
        replyTo: String(m.reply_to_message.message_id),
        text,
      })
  }

  private async tryPair(chat: string, text: string): Promise<boolean> {
    const pr = this.pairing
    const code = /^(?:\/start(?:@\w+)?\s+)?([A-Za-z0-9]{6})$/.exec(text)?.[1]
    if (!pr || code?.toUpperCase() !== pr.code) return false
    this.chatId = chat
    this.forum = undefined
    this.opts.onPaired?.(chat)
    pr.finish(chat)
    try {
      await this.call("sendMessage", {
        chat_id: chat,
        text: "Paired. Questions and notices of your OpenCode sessions arrive here.",
      })
    } catch (err) {
      this.fail(err)
    }
    return true
  }

  private async onCallback(
    cb: NonNullable<Update["callback_query"]>,
  ): Promise<void> {
    if (!cb.message || String(cb.message.chat.id) !== this.chatId) {
      this.rejected("callback")
      return log("telegram_ignored", { kind: "callback" })
    }
    const m = /^([A-Za-z0-9]+):(t?\d+|d)$/.exec(cb.data ?? "")
    if (!m) return this.toast(cb.id, "Unknown button.")
    const [, id, act] = m
    const message_id = cb.message.message_id
    const time = Math.floor(Date.now() / 1000)
    const reply = (r: Pick<Inbound, "choice" | "text">) =>
      this.answer(cb.id, {
        kind: "answer",
        id: `cb${cb.id}`,
        time,
        pendingId: id,
        from: { connector: this.id, chat: String(cb.message!.chat.id) },
        inline: true,
        ...r,
      })

    if (/^\d+$/.test(act)) return reply({ choice: Number(act), text: act })

    const p = this.prompts.get(id)
    if (!p)
      return this.toast(
        cb.id,
        `No longer active here: answer in the TUI, or send "#${id} 1,3".`,
      )
    if (act === "d") {
      if (p.selected.size === 0)
        return this.toast(cb.id, "Tick at least one option.")
      return reply({
        text: [...p.selected].sort((a, b) => a - b).join(","),
      })
    }
    const n = Number(act.slice(1))
    if (n < 1 || n > p.options.length)
      return this.toast(cb.id, "Unknown button.")
    if (!p.selected.delete(n)) p.selected.add(n)
    await this.toast(cb.id)
    try {
      await this.call("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id,
        reply_markup: this.keyboard(id, p.options, true, p.selected),
      })
    } catch (err) {
      this.fail(err)
    }
  }

  /** Applies a tap, and clears the button's spinner with the outcome. */
  private async answer(callbackID: string, m: Inbound): Promise<void> {
    const done = this.onInbound?.(m)
    const out = await Promise.race<Outcome | undefined | "late">([
      done ?? Promise.resolve(undefined),
      sleep(this.opts.toastAfterMs ?? 1000).then(() => "late" as const),
    ])
    await this.toast(
      callbackID,
      out === "late" ? "Sending…" : (out?.text ?? "Done."),
    )
    await done
  }

  private async toast(callbackID: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", {
        callback_query_id: callbackID,
        text: text ? truncate(filterSecrets(text), TOAST_MAX) : undefined,
      })
    } catch (err) {
      this.fail(err)
    }
  }
}

export type TelegramConfig = {
  token: TokenSource
  chatId?: string
  /** Bot API base URL; the public API unless a local Bot API server is used. */
  apiBase: string
}

export const telegramType: ConnectorType<TelegramConfig> = {
  parse(raw, at) {
    const token = parseTokenSource(raw.token)
    if (!token) return { error: `${at}${TOKEN_ERROR}` }

    let chatId: string | undefined
    if (raw.chatId !== undefined) {
      if (
        !(typeof raw.chatId === "number" && Number.isInteger(raw.chatId)) &&
        !(typeof raw.chatId === "string" && /^-?\d+$/.test(raw.chatId))
      )
        return { error: `${at}chatId must be a numeric chat id` }
      chatId = String(raw.chatId)
    }

    const apiBase = raw.apiBase ?? "https://api.telegram.org"
    if (typeof apiBase !== "string" || !URL_RE.test(apiBase))
      return { error: `${at}apiBase must be an http(s) URL` }

    return { token, chatId, apiBase: apiBase.replace(/\/+$/, "") }
  },

  create(env, o) {
    const stored = env.settings.get().chatId
    return new TelegramConnector({
      name: env.name,
      token: lazyToken(o.token),
      tel: env.tel,
      // A chat paired in the TUI wins over the file.
      chatId: typeof stored === "string" ? stored : o.chatId,
      apiBase: o.apiBase,
      offsetFile: join(env.dir, `${env.name}-offset.json`),
      topicsFile: join(env.dir, `${env.name}-topics.json`),
      onPaired: (chatId) => env.settings.set({ chatId }),
    })
  },
}
