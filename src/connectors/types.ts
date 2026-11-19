/**
 * What the core needs from a delivery connector (ntfy, Telegram, Matrix, ...).
 *
 * The core never branches on a connector's type. It reads `capabilities` and
 * degrades: no buttons, numbered text; no edit, a follow-up message; no
 * pairing, no pairing menu item.
 */
import type { Question } from "../inbound.ts"
import type { Telemetry } from "../otel.ts"

export type Capabilities = {
  /** Answer buttons on a question. Without them the question is numbered text. */
  buttons: boolean
  /** An earlier message can be rewritten. Without it the outcome is a new message. */
  edit: boolean
  /** Toggle-and-confirm buttons for a multiple-choice question. */
  multiselect: boolean
  /** Messages are grouped per session (threads, topics, rooms). */
  threads: boolean
  /** The connector can bind itself to a chat through `pair()`. */
  pairing: boolean
  /** Messages typed in a session's thread may be sent to the session. Not implemented by any connector yet. */
  inboundPrompt: boolean
}

/** Filled in by the connector during `send`/`update`, for the trace. */
export type SendStats = { httpStatus?: number; retries?: number }

export type Push = {
  title?: string
  message: string
  tags?: string[]
  priority?: 1 | 2 | 3 | 4 | 5
  /** The top-level session this push is about. Only set for connectors with `threads`. */
  session?: { id: string; name: string }
  /** A question to offer answer buttons for. Only set for connectors with `buttons`. */
  prompt?: { id: string; questions: Question[] }
  /** The connector may record transport facts here; it is never shown to anyone. */
  stats?: SendStats
}

/** Something a person sent through a connector. */
export type Inbound = {
  /** `answer` replies to a prompt; `prompt` is text for a session (reserved, ignored by the core for now). */
  kind: "answer" | "prompt"
  /** Transport message id, to tell a replay from a second answer. */
  id: string
  /** Seconds since the epoch. */
  time: number
  /** The pending prompt this answers, when the sender named it (a button, `#id answer`). */
  pendingId?: string
  /** Reference of the message replied to, when the sender replied to one. */
  replyTo?: string
  /** The thread or room it was sent in, as the connector's `send` grouped it. */
  sessionKey?: string
  text: string
  /** 1-based option from a button tap. */
  choice?: number
  /** `chat` identifies the sender's conversation; the connector has checked it is allowed. */
  from: { connector: string; chat: string }
  /** The connector shows the outcome itself (a button toast): no notice message. */
  inline?: boolean
}

export type Outcome = { ok: boolean; text: string }

/** Resolves undefined for input that is silently ignored. */
export type OnInbound = (m: Inbound) => Promise<Outcome | undefined>

export type ConnectorStatus = { connected?: boolean; lastError?: string }

export type Pairing = {
  /** One-time code the person gives the connector. */
  code: string
  /** Opens the connector with the code applied; the TUI renders it as a QR code. */
  link?: string
  /** Epoch ms. */
  expiresAt: number
  /** Short instruction for the dialog. */
  hint?: string
  /** True once paired, false when the code expired or was replaced. */
  done: Promise<boolean>
}

export interface Connector {
  /** Instance name, from the config key. */
  readonly id: string
  readonly type: string
  readonly capabilities: Capabilities
  enabled: boolean
  /** Starts receiving; returns at once. `openSince` is the ms time of the oldest unanswered prompt. */
  start(onInbound: OnInbound, signal: AbortSignal, openSince?: number): void
  /** How to answer this question here, for the `{{hint}}` placeholder. */
  hint(id: string, questions: Question[]): string
  /** Returns a reference to the sent message; never throws. */
  send(push: Push): Promise<string | undefined>
  /** Rewrites an earlier message; true when it did. Never throws. Required when `capabilities.edit`. */
  update?(ref: string, push: Push): Promise<boolean>
  /** Required when `capabilities.pairing`. */
  pair?(): Promise<Pairing>
  status(): ConnectorStatus
}

/** Per-connector state kept in the data directory, layered over the config file. */
export type ConnectorSettings = { enabled?: boolean } & Record<string, unknown>

export type ConnectorEnv = {
  /** Instance name. */
  name: string
  /** The data directory, for files of the connector's own. */
  dir: string
  tel: Telemetry
  settings: {
    get(): ConnectorSettings
    set(patch: ConnectorSettings): void
  }
}

/** A connector type: how to validate its options and how to build it. */
export interface ConnectorType<O = unknown> {
  /** Top-level config keys that mean this type's options in the pre-`channels` config form. */
  legacyKeys?: readonly string[]
  /** `raw` is the config object of one instance, including `type` and `enabled`. */
  parse(raw: Record<string, unknown>, at: string): O | { error: string }
  create(env: ConnectorEnv, options: O): Connector
}
