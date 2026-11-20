import { readFile } from "node:fs/promises"

import { legacyConfigPath, configPath, legacy } from "./paths.ts"
import { connectorTypes } from "./connectors/index.ts"
import { parseRedact, type Redact } from "./filter.ts"
import { parseJsonc } from "./jsonc.ts"
import {
  parseFormats,
  parseProfiles,
  type Formats,
  type Profile,
} from "./messages.ts"
import type { OtelTarget } from "./otel.ts"
import { isArgv, isObject, URL_RE } from "./util.ts"

export type Rule = {
  agent?: RegExp
  directory?: string
  command?: string[]
}

/** One configured connector instance. */
export type ChannelConfig = {
  /** Key in `connectorTypes`. */
  type: string
  enabled: boolean
  /** What the connector type's `parse` made of the instance's config. */
  options: unknown
}

/** Chat from a connector into a session. */
export type ChatConfig = {
  /** Sessions where chat stays off even after `/oob chat on`. */
  deny: Array<{ agent?: RegExp; directory?: string }>
  /** `replies`: every final reply of a chat-enabled session is posted; `remote-only`: only the turns started from the connector. */
  mirror: "replies" | "remote-only"
  /** Show a reply being written, in one message edited as it grows. */
  stream: boolean
}

export type Config = {
  /** By instance name. */
  channels: Record<string, ChannelConfig>
  /** `all`, or the name of a channel, for a session that chose none. */
  defaultChannel: string
  away: { minutes: number }
  rules: Rule[]
  redact: Redact
  chat: ChatConfig
  messages: Formats
  profiles: Profile[]
  /** Set when `otel.endpoint` is; the environment may still turn telemetry on. */
  otel?: OtelTarget
}

const NAME = /^[A-Za-z0-9][-_A-Za-z0-9]{0,23}$/

function parseChannels(
  raw: Record<string, unknown>,
): { channels: Record<string, ChannelConfig> } | { error: string } {
  if (raw.channels !== undefined && !isObject(raw.channels))
    return { error: "channels must be an object" }
  const given = isObject(raw.channels) ? raw.channels : {}
  const entries: Array<[name: string, cfg: unknown, at: string]> =
    Object.entries(given).map(([name, cfg]) => [name, cfg, `channels.${name}.`])

  // The pre-`channels` form: a type's own keys at the top level mean an instance named after the type.
  for (const [type, t] of Object.entries(connectorTypes)) {
    const keys = (t.legacyKeys ?? []).filter((k) => raw[k] !== undefined)
    if (keys.length === 0) continue
    if (given[type] !== undefined)
      return {
        error: `${keys.join(", ")} at the top level is the old form of channels.${type}: use one`,
      }
    entries.push([type, Object.fromEntries(keys.map((k) => [k, raw[k]])), ""])
  }

  const types = Object.keys(connectorTypes).join(", ")
  const out: Record<string, ChannelConfig> = {}
  for (const [name, cfg, at] of entries) {
    if (!NAME.test(name))
      return {
        error: `channels.${name}: use letters, digits, - and _ (24 at most)`,
      }
    if (!isObject(cfg)) return { error: `channels.${name} must be an object` }
    const type = cfg.type ?? name
    if (typeof type !== "string" || !connectorTypes[type])
      return {
        error: `${at || `channels.${name}.`}type ${String(type)} is unknown (use ${types})`,
      }
    const enabled = cfg.enabled ?? true
    if (typeof enabled !== "boolean")
      return { error: `${at}enabled must be true or false` }
    const options = connectorTypes[type].parse(cfg, at)
    if (isObject(options) && typeof options.error === "string")
      return { error: options.error }
    out[name] = { type, enabled, options }
  }
  if (Object.keys(out).length === 0)
    return { error: "configure a channel under channels" }
  return { channels: out }
}

function parseChat(raw: unknown): ChatConfig | { error: string } {
  if (raw === undefined) return { deny: [], mirror: "replies", stream: true }
  if (!isObject(raw)) return { error: "chat must be an object" }
  const mirror = raw.mirror ?? "replies"
  if (mirror !== "replies" && mirror !== "remote-only")
    return { error: 'chat.mirror must be "replies" or "remote-only"' }
  const stream = raw.stream ?? true
  if (typeof stream !== "boolean")
    return { error: "chat.stream must be true or false" }
  const deny: ChatConfig["deny"] = []
  if (raw.deny !== undefined && !Array.isArray(raw.deny))
    return { error: "chat.deny must be a list" }
  for (const d of (raw.deny as unknown[] | undefined) ?? []) {
    if (!isObject(d)) return { error: "each chat.deny entry must be an object" }
    const rule: ChatConfig["deny"][number] = {}
    try {
      if (typeof d.agent === "string") rule.agent = new RegExp(d.agent)
    } catch {
      return { error: `invalid chat.deny agent pattern ${d.agent}` }
    }
    if (typeof d.directory === "string") rule.directory = d.directory
    if (!rule.agent && !rule.directory)
      return { error: "a chat.deny entry needs agent or directory" }
    deny.push(rule)
  }
  return { deny, mirror, stream }
}

/** Validates a parsed config file. Returns the config or the first problem. */
export function parseConfig(raw: unknown): Config | { error: string } {
  if (!isObject(raw)) return { error: "config must be an object" }

  const parsed = parseChannels(raw)
  if ("error" in parsed) return parsed
  const configured = parsed.channels

  const defaultChannel = raw.defaultChannel ?? "all"
  if (typeof defaultChannel !== "string")
    return { error: "defaultChannel must be a channel name or all" }
  if (defaultChannel !== "all" && !configured[defaultChannel])
    return {
      error: `defaultChannel is ${defaultChannel}, which is not configured`,
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

  let otel: OtelTarget | undefined
  if (raw.otel !== undefined) {
    if (!isObject(raw.otel)) return { error: "otel must be an object" }
    if (raw.otel.endpoint !== undefined) {
      if (
        typeof raw.otel.endpoint !== "string" ||
        !URL_RE.test(raw.otel.endpoint)
      )
        return { error: "otel.endpoint must be an http(s) URL" }
      const h = raw.otel.headers
      if (
        h !== undefined &&
        (!isObject(h) || !Object.values(h).every((v) => typeof v === "string"))
      )
        return { error: "otel.headers must map names to strings" }
      otel = {
        endpoint: raw.otel.endpoint,
        headers: h as Record<string, string> | undefined,
      }
    }
  }

  const chat = parseChat(raw.chat)
  if ("error" in chat) return chat

  const messages = parseFormats(raw.messages, "messages")
  if (typeof messages === "string") return { error: messages }
  const profiles = parseProfiles(raw.profiles)
  if (typeof profiles === "string") return { error: profiles }

  return {
    channels: configured,
    defaultChannel,
    away: { minutes },
    rules,
    redact,
    chat,
    messages,
    profiles,
    otel,
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
    // Only the default location falls back; an explicit path never does.
    if (legacy(process.env, "CONFIG") || path !== configPath()) return undefined
    try {
      path = legacyConfigPath()
      text = await readFile(path, "utf8")
    } catch {
      return undefined
    }
  }
  try {
    return parseConfig(parseJsonc(text))
  } catch (err) {
    return { error: `cannot parse ${path}: ${(err as Error).message}` }
  }
}

export { configPath, dataDir, legacyConfigPath, logPath } from "./paths.ts"
