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
import { isObject, sleep, truncate, URL_RE } from "../util.ts"
import { globToRegExp } from "../routing.ts"
import {
  esc,
  keycap,
  renderPush,
  renderStatus,
  starred,
} from "./telegram-render.ts"
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
  SessionState,
} from "./types.ts"

const MAX_BUTTONS = 10
const LABEL_MAX = 40
const POLL_SECONDS = 30
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const PAIR_TTL_MS = 10 * 60_000
const TOAST_MAX = 190
const TOPIC_RETRY_MS = 5 * 60_000
const TOPIC_NOTICE_MS = 60 * 60_000
const RENAME_GAP_MS = 60_000
const CARD_GAP_MS = 10_000
// The six colors Telegram allows for a topic icon.
const COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047]
// Sessions of one project draw their icon from this many neighbours.
const FAMILY = 4
const RIGHTS = /not enough rights|admin/i
const RIGHTS_NOTICE =
  "⚠️ I need the Manage Topics admin right to give each session its own topic. Posting in General until then."

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
  /** One status card per session topic; on unless false. */
  statusCard?: boolean
  /** Session-end pushes wanted; finished defaults to off while the card shows it. */
  notify?: { finished?: boolean; failed?: boolean }
  /** `agent regex or project glob` to the emoji it picks for a topic icon. */
  icons?: Record<string, string>
  /** Clock, for the topic and card limits. */
  now?: () => number
}

type Update = {
  update_id: number
  message?: {
    message_id: number
    date: number
    text?: string
    chat: { id: number; title?: string; is_forum?: boolean }
    message_thread_id?: number
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    data?: string
    message?: {
      message_id: number
      message_thread_id?: number
      chat: { id: number }
    }
  }
}

type Markup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

const buttonable = (qs: Question[]) =>
  qs.length === 1 &&
  qs[0].options.length > 0 &&
  qs[0].options.length <= MAX_BUTTONS

/** What is kept of a session's topic. A bare number is the older file format. */
type Topic = {
  thread: number
  card?: number
  name?: string
  iconId?: string
  icon?: string
  /** What the card shows now; not kept across restarts. */
  cardText?: string
}

type Sticker = { emoji?: string; custom_emoji_id?: string }

/** FNV-1a: the same text always picks the same icon and color. */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export class TelegramConnector implements Connector {
  readonly type = "telegram"
  readonly capabilities: Capabilities = {
    buttons: true,
    edit: true,
    multiselect: true,
    rich: true,
    threads: true,
    pairing: true,
    // Sending prompts into sessions from a chat is not built yet.
    inboundPrompt: false,
  }
  readonly id: string
  readonly notify: { finished: boolean; failed: boolean }
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
  private topics: Map<string, Topic> | undefined
  private readonly topicJobs = new Map<string, Promise<number | undefined>>()
  /** Topic icons the bot may use: undefined until fetched, empty when the call failed. */
  private stickers: Sticker[] | undefined
  private stickersAt = -Infinity
  /** Per session: the state to show, and when the topic and card were last edited. */
  private readonly live = new Map<
    string,
    {
      want: SessionState
      renamedAt: number
      editedAt: number
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  /** No topic creation before this time, after a failure. */
  private topicRetryAt = 0
  private topicNoticeAt = -Infinity
  /** Set while topic creation is refused for missing rights. */
  private topicWarning: string | undefined
  /** Force-reply prompts: message id to the pending prompt it collects a typed answer for. */
  private readonly typing = new Map<string, string>()
  private pairing:
    | { code: string; finish: (chatId: string | undefined) => void }
    | undefined
  /** Prompts with a keyboard: the options and what is ticked. */
  private readonly prompts = new Map<
    string,
    {
      options: string[]
      multiple: boolean
      custom: boolean
      selected: Set<number>
      ref?: string
    }
  >()

  private readonly opts: TelegramOptions
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(opts: TelegramOptions, enabled = true) {
    this.opts = opts
    this.id = opts.name ?? "telegram"
    this.enabled = enabled
    this.chatId = opts.chatId
    this.fetch = opts.fetch ?? globalThis.fetch
    this.now = opts.now ?? Date.now
    this.notify = {
      finished: opts.notify?.finished ?? opts.statusCard === false,
      failed: opts.notify?.failed ?? true,
    }
  }

  start(onInbound: OnInbound, signal: AbortSignal): void {
    this.onInbound = onInbound
    this.signal = signal
    signal.addEventListener("abort", () => {
      for (const l of this.live.values()) clearTimeout(l.timer)
      this.live.clear()
    })
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
      warning: this.topicWarning,
    }
  }

  hint(id: string, qs: Question[]): string {
    if (qs.length !== 1)
      return `Reply to this message with one answer per question, separated by | (for example: 1 | yes | 2,3). Options are numbered.`
    const q = qs[0]
    const type = q.custom ? ", ✏️ to type" : ""
    if (q.multiple)
      return buttonable(qs)
        ? `Tick options${type}, then tap Done. Or reply with numbers, like 1,3.`
        : `Reply to this message with numbers, like 1,3.`
    if (buttonable(qs)) return `Tap a button${type}, or reply.`
    return `Reply to this message with a number or text (or send "#${id} <answer>").`
  }

  async send(push: Push): Promise<string | undefined> {
    if (!this.chatId) return undefined
    const q = push.prompt
    const live = q && buttonable(q.questions) ? q : undefined
    const one = live?.questions[0]
    if (live && one)
      this.prompts.set(live.id, {
        options: one.options,
        multiple: one.multiple,
        custom: one.custom,
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
              text: renderPush(push, {
                inTopic: thread !== undefined,
                footer:
                  q && push.card?.kind === "question"
                    ? this.hint(q.id, q.questions)
                    : undefined,
              }),
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              // A failure needs attention: it is the one push that may make a sound.
              disable_notification:
                push.card?.kind === "failed"
                  ? false
                  : (push.priority ?? 3) <= 2,
              reply_markup:
                live && one
                  ? this.keyboard(
                      live.id,
                      one.options,
                      one.multiple,
                      one.custom,
                      new Set(),
                    )
                  : undefined,
            },
            undefined,
            undefined,
            push.stats,
          )
          const ref = String(m.message_id)
          const p = live && this.prompts.get(live.id)
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
      if (push.prompt) this.prompts.delete(push.prompt.id)
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
    if (known !== undefined) return known.thread
    // After a failure the main chat is used, and creation is tried again later.
    if (this.now() < this.topicRetryAt) return undefined
    let job = this.topicJobs.get(key)
    if (!job) {
      job = this.createTopic(key, session).finally(() =>
        this.topicJobs.delete(key),
      )
      this.topicJobs.set(key, job)
    }
    return job
  }

  private async createTopic(
    key: string,
    session: NonNullable<Push["session"]>,
  ): Promise<number | undefined> {
    try {
      const name = truncate(filterSecrets(session.name), 128)
      const icon = await this.pickIcon(session)
      const t = await this.call<{ message_thread_id: number }>(
        "createForumTopic",
        {
          chat_id: this.chatId,
          name,
          icon_color:
            COLORS[hash(session.project ?? session.id) % COLORS.length],
          icon_custom_emoji_id: icon?.custom_emoji_id,
        },
      )
      this.topicWarning = undefined
      this.topics!.set(key, {
        thread: t.message_thread_id,
        name,
        iconId: icon?.custom_emoji_id,
        icon: icon?.emoji,
      })
      await this.saveTopics()
      return t.message_thread_id
    } catch (err) {
      // The main chat still works. Another session must not retry at once.
      this.topicRetryAt = this.now() + TOPIC_RETRY_MS
      this.fail(err)
      if (RIGHTS.test((err as Error).message)) await this.rightsMissing()
      return undefined
    }
  }

  /** The icons a bot may use, fetched once; a failed call is retried after a while and meanwhile only the color is set. */
  private async icons(): Promise<Sticker[]> {
    if (this.stickers?.length || this.now() - this.stickersAt < TOPIC_RETRY_MS)
      return this.stickers ?? []
    this.stickersAt = this.now()
    try {
      this.stickers = await this.call<Sticker[]>(
        "getForumTopicIconStickers",
        {},
      )
    } catch (err) {
      this.stickers = []
      this.fail(err)
    }
    return this.stickers
  }

  /**
   * The icon of a session's topic, the same every time: the configured emoji
   * for its agent or project, else one of a few neighbours picked by the
   * project, chosen between by the session.
   */
  private async pickIcon(
    session: NonNullable<Push["session"]>,
  ): Promise<Sticker | undefined> {
    const list = (await this.icons()).filter((i) => i.custom_emoji_id)
    if (list.length === 0) return undefined
    for (const [pattern, emoji] of Object.entries(this.opts.icons ?? {})) {
      let hit = false
      try {
        hit =
          new RegExp(pattern).test(session.agent ?? "") ||
          globToRegExp(pattern).test(session.project ?? "")
      } catch {}
      const sticker = hit && list.find((i) => i.emoji === emoji)
      if (sticker) return sticker
    }
    const base = hash(session.project ?? session.id)
    return list[(base + (hash(session.id) % FAMILY)) % list.length]
  }

  /** Missing "Manage Topics": a standing warning, and one notice an hour in the chat. */
  private async rightsMissing(): Promise<void> {
    this.topicWarning =
      "topics: the bot needs the Manage Topics admin right; posting in General"
    const now = this.now()
    if (now - this.topicNoticeAt < TOPIC_NOTICE_MS) return
    this.topicNoticeAt = now
    try {
      await this.call("sendMessage", {
        chat_id: this.chatId,
        text: RIGHTS_NOTICE,
        link_preview_options: { is_disabled: true },
      })
    } catch (err) {
      this.fail(err)
    }
  }

  private async loadTopics(): Promise<Map<string, Topic>> {
    const file = this.opts.topicsFile
    const out = new Map<string, Topic>()
    if (!file) return out
    try {
      const v = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >
      for (const [k, t] of Object.entries(v)) {
        if (typeof t === "number") out.set(k, { thread: t })
        else if (
          typeof t === "object" &&
          t !== null &&
          typeof (t as Topic).thread === "number"
        )
          out.set(k, t as Topic)
      }
    } catch {}
    return out
  }

  private async saveTopics(): Promise<void> {
    const file = this.opts.topicsFile
    if (!file || !this.topics) return
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(
        file,
        JSON.stringify(
          Object.fromEntries(
            [...this.topics].map(([k, { cardText: _, ...t }]) => [k, t]),
          ),
        ),
      )
    } catch (err) {
      log("telegram_topics_error", { message: (err as Error).message })
    }
  }

  /**
   * Shows a session's state: renames its topic when the title changed (at most
   * once a minute) and keeps one pinned status card current (at most one edit
   * every ten seconds). A change that comes too soon is applied later.
   */
  async track(state: SessionState): Promise<void> {
    try {
      const session = {
        id: state.id,
        name: state.name,
        project: state.project,
        agent: state.agent,
      }
      if ((await this.thread(session)) === undefined) return
      const key = this.topicKey(state.id)
      const live = this.live.get(key) ?? {
        want: state,
        renamedAt: -Infinity,
        editedAt: -Infinity,
      }
      live.want = state
      this.live.set(key, live)
      await this.flush(key)
    } catch (err) {
      this.fail(err)
    }
  }

  private async flush(key: string): Promise<void> {
    const live = this.live.get(key)
    const topic = this.topics?.get(key)
    if (!live || !topic || !this.chatId) return
    clearTimeout(live.timer)
    const s = live.want
    const name = truncate(filterSecrets(s.name), 128)
    const now = this.now()
    let wait = Infinity
    const due = (last: number, gap: number) => {
      if (last + gap <= now) return true
      wait = Math.min(wait, last + gap - now)
      return false
    }

    const icon = await this.pickIcon(s)
    const newIcon =
      icon && icon.custom_emoji_id !== topic.iconId ? icon : undefined
    if (
      (topic.name !== name || newIcon) &&
      due(live.renamedAt, RENAME_GAP_MS)
    ) {
      live.renamedAt = now
      try {
        await this.call("editForumTopic", {
          chat_id: this.chatId,
          message_thread_id: topic.thread,
          name: topic.name !== name ? name : undefined,
          icon_custom_emoji_id: newIcon?.custom_emoji_id,
        })
        topic.name = name
        if (newIcon) {
          topic.iconId = newIcon.custom_emoji_id
          topic.icon = newIcon.emoji
        }
        await this.saveTopics()
      } catch (err) {
        this.fail(err)
      }
    }

    if (this.opts.statusCard !== false) {
      const text = renderStatus(s, topic.icon)
      if (topic.cardText !== text && due(live.editedAt, CARD_GAP_MS)) {
        live.editedAt = now
        await this.card(topic, text)
      }
    }
    if (wait < Infinity) {
      live.timer = setTimeout(() => void this.flush(key), wait)
      live.timer.unref?.()
    }
  }

  /** Creates, pins or edits the status card of a topic. */
  private async card(topic: Topic, text: string): Promise<void> {
    try {
      if (topic.card === undefined) {
        const m = await this.call<{ message_id: number }>("sendMessage", {
          chat_id: this.chatId,
          message_thread_id: topic.thread,
          text,
          parse_mode: "HTML",
          disable_notification: true,
        })
        topic.card = m.message_id
        await this.saveTopics()
        // A card that cannot be pinned is still a card.
        await this.call("pinChatMessage", {
          chat_id: this.chatId,
          message_id: m.message_id,
          disable_notification: true,
        }).catch((err) => this.fail(err))
      } else {
        await this.call("editMessageText", {
          chat_id: this.chatId,
          message_id: topic.card,
          text,
          parse_mode: "HTML",
        })
      }
      topic.cardText = text
    } catch (err) {
      const m = (err as Error).message
      if (/not modified/i.test(m)) topic.cardText = text
      // Deleted in Telegram: the next change makes a new one.
      else if (/not found/i.test(m)) {
        topic.card = undefined
        await this.saveTopics()
      }
      this.fail(err)
    }
  }

  async update(ref: string, push: Push): Promise<boolean> {
    if (!this.chatId) return false
    for (const [id, p] of this.prompts)
      if (p.ref === ref) {
        this.prompts.delete(id)
        for (const [m, to] of this.typing) if (to === id) this.typing.delete(m)
      }
    try {
      await this.call(
        "editMessageText",
        {
          chat_id: this.chatId,
          message_id: Number(ref),
          text: renderPush(push),
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
      links: username
        ? [
            {
              label:
                "Or add it to a group (a group with Topics gives each session its own)",
              url: `https://t.me/${username}?startgroup=${code}`,
            },
          ]
        : undefined,
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
    custom: boolean,
    selected: Set<number>,
  ): Markup {
    const rows = options.map((label, i) => [
      {
        text: truncate(
          `${multiple && selected.has(i + 1) ? "✓ " : ""}${keycap(i + 1)} ${starred(label)}`,
          LABEL_MAX,
        ),
        callback_data: `${id}:${multiple ? "t" : ""}${i + 1}`,
      },
    ])
    if (custom)
      rows.push([{ text: "✏️ Type an answer", callback_data: `${id}:x` }])
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
    if (await this.tryPair(m.chat, text)) return
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
    // A reply to a "Type your answer" prompt is a free-text answer for its prompt.
    const asked = m.reply_to_message
      ? this.typing.get(String(m.reply_to_message.message_id))
      : undefined
    if (asked)
      return void (await this.onInbound?.({
        ...base,
        pendingId: asked,
        text,
        literal: true,
      }))
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

  /**
   * The one-time code, typed or sent as `/start <code>` (`/start@bot <code>` in
   * a group), from a private chat or a group.
   */
  private async tryPair(
    chat: NonNullable<Update["message"]>["chat"],
    text: string,
  ): Promise<boolean> {
    const pr = this.pairing
    const code = /^(?:\/start(?:@\w+)?\s+)?([A-Za-z0-9]{6})$/.exec(text)?.[1]
    if (!pr || code?.toUpperCase() !== pr.code) return false
    const id = String(chat.id)
    this.chatId = id
    this.forum = chat.is_forum === true ? true : undefined
    this.opts.onPaired?.(id)
    pr.finish(id)
    const what = chat.title
      ? `Paired with ${esc(chat.title)}.${chat.is_forum ? " One topic per session." : ""}`
      : "Paired. Questions and notices of your OpenCode sessions arrive here."
    try {
      await this.call("sendMessage", {
        chat_id: id,
        text: what,
        parse_mode: "HTML",
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
    const m = /^([A-Za-z0-9]+):(t?\d+|d|x)$/.exec(cb.data ?? "")
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
    if (act === "x") return this.askTyped(cb.id, id, cb.message)

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
        reply_markup: this.keyboard(id, p.options, true, p.custom, p.selected),
      })
    } catch (err) {
      this.fail(err)
    }
  }

  /** "✏️ Type an answer": the bot asks for it, and a reply to that message is the answer. */
  private async askTyped(
    callbackID: string,
    id: string,
    at: NonNullable<NonNullable<Update["callback_query"]>["message"]>,
  ): Promise<void> {
    await this.toast(callbackID)
    try {
      const m = await this.call<{ message_id: number }>("sendMessage", {
        chat_id: this.chatId,
        message_thread_id: at.message_thread_id,
        text: `Type your answer for #${id}`,
        reply_markup: {
          force_reply: true,
          input_field_placeholder: "Your answer",
        },
      })
      this.typing.set(String(m.message_id), id)
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
  statusCard: boolean
  notify: { finished?: boolean; failed?: boolean }
  icons: Record<string, string>
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

    const statusCard = raw.statusCard ?? true
    if (typeof statusCard !== "boolean")
      return { error: `${at}statusCard must be true or false` }

    const notify: TelegramConfig["notify"] = {}
    if (raw.notify !== undefined) {
      if (!isObject(raw.notify))
        return { error: `${at}notify must be an object` }
      for (const k of ["finished", "failed"] as const) {
        const v = raw.notify[k]
        if (v !== undefined && typeof v !== "boolean")
          return { error: `${at}notify.${k} must be true or false` }
        notify[k] = v
      }
    }

    const icons: Record<string, string> = {}
    if (raw.icons !== undefined) {
      if (!isObject(raw.icons))
        return { error: `${at}icons must map patterns to emoji` }
      for (const [k, v] of Object.entries(raw.icons)) {
        if (typeof v !== "string" || !v)
          return { error: `${at}icons.${k} must be an emoji` }
        icons[k] = v
      }
    }

    return {
      token,
      chatId,
      apiBase: apiBase.replace(/\/+$/, ""),
      statusCard,
      notify,
      icons,
    }
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
      statusCard: o.statusCard,
      notify: o.notify,
      icons: o.icons,
      offsetFile: join(env.dir, `${env.name}-offset.json`),
      topicsFile: join(env.dir, `${env.name}-topics.json`),
      onPaired: (chatId) => env.settings.set({ chatId }),
    })
  },
}
