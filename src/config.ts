import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { parseRedact, type Redact } from "./filter.ts"
import { parseJsonc } from "./jsonc.ts"

export type TokenSource = { env: string } | { command: string[] }

export type Rule = {
  agent?: RegExp
  directory?: string
  command?: string[]
}

export type Config = {
  server: string
  token?: TokenSource
  topics: { out: string; in: string }
  away: { minutes: number }
  rules: Rule[]
  redact: Redact
}

type Env = NodeJS.ProcessEnv

export function configPath(env: Env = process.env): string {
  if (env.OPENCODE_NTFY_BRIDGE_CONFIG) return env.OPENCODE_NTFY_BRIDGE_CONFIG
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "ntfy-bridge.jsonc")
}

export function dataDir(env: Env = process.env): string {
  if (env.OPENCODE_NTFY_BRIDGE_DATA) return env.OPENCODE_NTFY_BRIDGE_DATA
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode", "ntfy-bridge")
}

export function logPath(env: Env = process.env): string {
  return env.OPENCODE_NTFY_BRIDGE_LOG || join(dataDir(env), "bridge.log")
}

const TOPIC = /^[-_A-Za-z0-9]{1,64}$/

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const isArgv = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string")

/** Validates a parsed config file. Returns the config or the first problem. */
export function parseConfig(raw: unknown): Config | { error: string } {
  if (!isObject(raw)) return { error: "config must be an object" }
  const server = raw.server
  if (typeof server !== "string" || !/^https?:\/\/[^\s/]+/.test(server))
    return { error: "server must be an http(s) URL" }

  let token: TokenSource | undefined
  if (raw.token !== undefined) {
    const t = raw.token
    if (isObject(t) && typeof t.env === "string" && t.env)
      token = { env: t.env }
    else if (isObject(t) && isArgv(t.command)) token = { command: t.command }
    // A literal token in the file is refused: it belongs in the environment or a secret store.
    else
      return { error: 'token must be { "env": NAME } or { "command": [...] }' }
  }

  const topics = raw.topics
  if (
    !isObject(topics) ||
    typeof topics.out !== "string" ||
    typeof topics.in !== "string" ||
    !TOPIC.test(topics.out) ||
    !TOPIC.test(topics.in) ||
    topics.out === topics.in
  )
    return {
      error: "topics.out and topics.in must be two different topic names",
    }

  const away = isObject(raw.away) ? raw.away : {}
  const minutes = away.minutes === undefined ? 10 : away.minutes
  if (typeof minutes !== "number" || !(minutes > 0))
    return { error: "away.minutes must be a positive number" }

  const rules: Rule[] = []
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    if (!isObject(r)) return { error: "each rule must be an object" }
    const rule: Rule = {}
    try {
      if (typeof r.agent === "string") rule.agent = new RegExp(r.agent)
    } catch {
      return { error: `invalid agent pattern ${r.agent}` }
    }
    if (typeof r.directory === "string") rule.directory = r.directory
    if (isArgv(r.command)) rule.command = r.command
    if (!rule.agent && !rule.directory && !rule.command)
      return { error: "a rule needs agent, directory or command" }
    rules.push(rule)
  }

  const redact = parseRedact(raw.redact)
  if (!redact) return { error: 'redact must be "full", "title" or "head:<n>"' }

  // Tier 2 (remote permission replies) is not implemented: every permission is push-only.
  const tier = isObject(raw.permissions) ? raw.permissions.tier : undefined
  if (tier !== undefined && tier !== 3)
    return { error: "permissions.tier: only 3 (push only) is supported" }

  return {
    server: server.replace(/\/+$/, ""),
    token,
    topics: { out: topics.out, in: topics.in },
    away: { minutes },
    rules,
    redact,
  }
}

/** Reads the config file. No file means the plugin stays inert. */
export async function loadConfig(
  path = configPath(),
): Promise<Config | { error: string } | undefined> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return undefined
  }
  try {
    return parseConfig(parseJsonc(text))
  } catch (err) {
    return { error: `cannot parse ${path}: ${(err as Error).message}` }
  }
}
