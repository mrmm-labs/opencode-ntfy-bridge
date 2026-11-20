/**
 * The reaction a prompt from Telegram gets: it names the agent that received it,
 * or says the message was queued or steered in. A bot may set one reaction per
 * message, and only from the set Telegram allows bots, so every choice is
 * checked against that set and falls back to 👀.
 */

// The emoji Telegram lets a bot react with (Bot API, ReactionTypeEmoji).
const ALLOWED_LIST = [
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
]

/** Telegram writes these without the emoji variation selector; people type them with it. */
export const plain = (e: string) => e.replace(/\uFE0F/g, "")

export const ALLOWED_REACTIONS: ReadonlySet<string> = new Set(
  ALLOWED_LIST.map(plain),
)

export const FALLBACK_REACTION = "👀"

export type Reactions = {
  /** Lower-case agent name to its emoji. */
  agents: Record<string, string>
  /** An agent with no entry. */
  default: string
  /** Sent while the session was busy and the message waits for the turn to end. */
  queued: string
  /** Sent into the running turn. */
  steered: string
}

export const DEFAULT_REACTIONS: Reactions = {
  agents: {
    build: "👨‍💻",
    plan: "🤔",
    general: "😎",
    explore: "🤓",
    coordinator: "🫡",
  },
  default: FALLBACK_REACTION,
  queued: "✍",
  steered: "⚡",
}

/** What the config file may hold under `reactions`; the rest comes from the defaults. */
export type ReactionsConfig = {
  agents?: Record<string, string>
  default?: string
  queued?: string
  steered?: string
}

const KEYS = ["agents", "default", "queued", "steered"]

export function parseReactions(
  raw: unknown,
  at: string,
): { reactions: ReactionsConfig } | { error: string } {
  if (raw === undefined) return { reactions: {} }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: `${at}reactions must be an object` }
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(o))
    if (!KEYS.includes(k))
      return {
        error: `${at}reactions.${k} is not a setting (use ${KEYS.join(", ")})`,
      }
  const out: ReactionsConfig = {}
  for (const k of ["default", "queued", "steered"] as const) {
    const v = o[k]
    if (v === undefined) continue
    if (typeof v !== "string" || !v)
      return { error: `${at}reactions.${k} must be an emoji` }
    out[k] = v
  }
  if (o.agents !== undefined) {
    if (
      typeof o.agents !== "object" ||
      o.agents === null ||
      Array.isArray(o.agents)
    )
      return { error: `${at}reactions.agents must map agent names to emoji` }
    out.agents = {}
    for (const [k, v] of Object.entries(o.agents)) {
      if (typeof v !== "string" || !v)
        return { error: `${at}reactions.agents.${k} must be an emoji` }
      out.agents[k.toLowerCase()] = v
    }
  }
  return { reactions: out }
}

export type Delivered = { agent?: string; how: "sent" | "queued" | "steered" }

/**
 * The emoji to react with. A choice outside Telegram's set is replaced by the
 * configured default, then by 👀; `bad` is told about each one that was.
 */
export function reactionFor(
  cfg: ReactionsConfig | undefined,
  d: Delivered | undefined,
  bad?: (emoji: string) => void,
): string {
  const ok = (e: string | undefined) => {
    if (e === undefined) return undefined
    const p = plain(e)
    if (ALLOWED_REACTIONS.has(p)) return p
    bad?.(e)
    return undefined
  }
  const fallback =
    ok(cfg?.default) ?? ok(DEFAULT_REACTIONS.default) ?? FALLBACK_REACTION
  if (d?.how === "queued")
    return ok(cfg?.queued ?? DEFAULT_REACTIONS.queued) ?? fallback
  if (d?.how === "steered")
    return ok(cfg?.steered ?? DEFAULT_REACTIONS.steered) ?? fallback
  const agent = d?.agent?.toLowerCase()
  if (!agent) return fallback
  return ok(cfg?.agents?.[agent] ?? DEFAULT_REACTIONS.agents[agent]) ?? fallback
}
