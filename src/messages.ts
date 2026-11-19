/**
 * Push formats. Each kind has a built-in default; the config's `messages`
 * overrides it field by field, and the first matching `profiles` entry
 * overrides that. `{{name}}` placeholders are filled per push; an unknown
 * name renders empty, and a tag that renders empty is dropped.
 */
import { globToRegExp } from "./routing.ts"

export const KINDS = [
  "question",
  "permission",
  "finished",
  "failed",
  "closed",
  "notice",
] as const
export type Kind = (typeof KINDS)[number]

export type Format = {
  title?: string
  message?: string
  tags?: string[]
  priority?: 1 | 2 | 3 | 4 | 5
}
export type Formats = Partial<Record<Kind, Format>>
export type Profile = { agent?: RegExp; directory?: string; messages: Formats }

export const DEFAULTS: Record<Kind, Required<Format>> = {
  question: {
    title: "{{project}} · {{agent}} asks",
    message: "{{thread}}{{body}}\n\n{{hint}}",
    tags: ["question", "{{subagent}}"],
    priority: 4,
  },
  permission: {
    title: "{{project}} · {{agent}} needs permission",
    message:
      "{{detail}}\n\nAnswer in the OpenCode TUI. Permissions are never applied remotely.",
    tags: ["lock", "{{subagent}}"],
    priority: 4,
  },
  finished: {
    title: "{{project}} · session finished",
    message: "{{session}}",
    tags: ["white_check_mark"],
    priority: 2,
  },
  failed: {
    title: "{{project}} · session failed",
    message: "{{session}}",
    tags: ["x"],
    priority: 2,
  },
  closed: {
    title: "{{title}}",
    message: "{{note}}",
    tags: ["white_check_mark"],
    priority: 1,
  },
  notice: {
    title: "oob bridge",
    message: "{{text}}",
    tags: ["warning"],
    priority: 2,
  },
}

export type Vars = Record<string, string | undefined>

const fill = (t: string, vars: Vars) =>
  t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "")

const pickProfile = (
  profiles: Profile[],
  session?: { agent?: string; directory?: string },
) =>
  session
    ? profiles.find(
        (p) =>
          (!p.agent || p.agent.test(session.agent ?? "")) &&
          (!p.directory ||
            globToRegExp(p.directory).test(session.directory ?? "")),
      )
    : undefined

/** Whether the user set any field of this kind in `messages` or a matching profile. */
export function isCustomized(
  kind: Kind,
  messages: Formats = {},
  profiles: Profile[] = [],
  session?: { agent?: string; directory?: string },
): boolean {
  const has = (f?: Format) => f !== undefined && Object.keys(f).length > 0
  return (
    has(messages[kind]) || has(pickProfile(profiles, session)?.messages[kind])
  )
}

export function format(
  kind: Kind,
  vars: Vars,
  messages: Formats = {},
  profiles: Profile[] = [],
  session?: { agent?: string; directory?: string },
): Required<Format> {
  const profile = pickProfile(profiles, session)
  const f = { ...DEFAULTS[kind], ...messages[kind], ...profile?.messages[kind] }
  return {
    title: fill(f.title, vars),
    message: fill(f.message, vars),
    tags: f.tags.map((t) => fill(t, vars)).filter(Boolean),
    priority: f.priority,
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Validates a `messages` object. */
export function parseFormats(raw: unknown, at: string): Formats | string {
  if (raw === undefined) return {}
  if (!isObject(raw)) return `${at} must be an object`
  const out: Formats = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!(KINDS as readonly string[]).includes(k))
      return `${at}.${k}: unknown kind (use ${KINDS.join(", ")})`
    if (!isObject(v)) return `${at}.${k} must be an object`
    const f: Format = {}
    for (const field of ["title", "message"] as const) {
      if (v[field] === undefined) continue
      if (typeof v[field] !== "string")
        return `${at}.${k}.${field} must be a string`
      f[field] = v[field]
    }
    if (v.tags !== undefined) {
      if (!Array.isArray(v.tags) || !v.tags.every((t) => typeof t === "string"))
        return `${at}.${k}.tags must be a list of strings`
      f.tags = v.tags
    }
    if (v.priority !== undefined) {
      if (![1, 2, 3, 4, 5].includes(v.priority as number))
        return `${at}.${k}.priority must be 1 to 5`
      f.priority = v.priority as Format["priority"]
    }
    out[k as Kind] = f
  }
  return out
}

/** Validates `profiles`: each one needs agent or directory, plus messages. */
export function parseProfiles(raw: unknown): Profile[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return "profiles must be a list"
  const out: Profile[] = []
  for (const [i, p] of raw.entries()) {
    const at = `profiles[${i}]`
    if (!isObject(p)) return `${at} must be an object`
    const profile: Profile = { messages: {} }
    if (typeof p.agent === "string") {
      try {
        profile.agent = new RegExp(p.agent)
      } catch {
        return `${at}.agent: invalid pattern ${p.agent}`
      }
    }
    if (typeof p.directory === "string") profile.directory = p.directory
    if (!profile.agent && !profile.directory)
      return `${at} needs agent or directory`
    const m = parseFormats(p.messages, `${at}.messages`)
    if (typeof m === "string") return m
    profile.messages = m
    out.push(profile)
  }
  return out
}
