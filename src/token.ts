import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { registerSecret } from "./filter.ts"
import { log } from "./logger.ts"
import { isArgv, isObject } from "./util.ts"

export type TokenSource = { env: string } | { command: string[] }

/** A literal token in the config is refused: it belongs in the environment or a secret store. */
export function parseTokenSource(t: unknown): TokenSource | undefined {
  if (isObject(t) && typeof t.env === "string" && t.env) return { env: t.env }
  if (isObject(t) && isArgv(t.command)) return { command: t.command }
  return undefined
}

export const TOKEN_ERROR =
  'token must be { "env": NAME } or { "command": [...] }'

const run = promisify(execFile)

/**
 * Resolves a channel token from the environment or a command (run async, never
 * through a shell). The value is registered with the secret filter, so it is
 * masked in every push and log line, and is never logged itself.
 */
export async function resolveToken(
  source: TokenSource | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (!source) return undefined
  let value: string | undefined
  if ("env" in source) value = env[source.env]?.trim()
  else {
    const [cmd, ...args] = source.command
    const { stdout } = await run(cmd, args, {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    })
    value = stdout.trim()
  }
  registerSecret(value)
  return value || undefined
}

/** Retry delays after a failed token command: then every five minutes. */
const RETRY_MS = [30_000, 60_000, 120_000, 300_000]

const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** What a status view says while the token is not available. */
export const tokenWaitText = (retryAt: number) =>
  `waiting for token (retry ${clock(retryAt)})`

/** The token cannot be had now, and will not be asked for again before `retryAt`. */
export class TokenUnavailable extends Error {
  readonly retryAt: number
  constructor(retryAt: number, why?: string) {
    super(why ?? tokenWaitText(retryAt))
    this.retryAt = retryAt
  }
}

export type TokenFn = (() => Promise<string | undefined>) & {
  /** When the next try will be made, while the token is unavailable. */
  retryAt?: () => number | undefined
}

/**
 * Resolves once and caches. A failed command is not run again at once: the
 * next tries wait 30 s, 1 min, 2 min, then 5 min, and callers in between get
 * a TokenUnavailable. Each step is logged once.
 */
export function lazyToken(
  source: TokenSource | undefined,
  now: () => number = Date.now,
): TokenFn {
  let token: Promise<string | undefined> | undefined
  let failures = 0
  let retryAt = 0
  const get: TokenFn = async () => {
    if (token) return token
    if (retryAt > now()) throw new TokenUnavailable(retryAt)
    const attempt = resolveToken(source).then(
      (v) => {
        failures = 0
        retryAt = 0
        return v
      },
      (err: Error) => {
        token = undefined
        const wait = RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]
        retryAt = now() + wait
        log("token_unavailable", {
          attempt: failures,
          retry_in_s: wait / 1000,
          message: err.message,
        })
        throw new TokenUnavailable(retryAt, `token failed: ${err.message}`)
      },
    )
    token = attempt
    return attempt
  }
  get.retryAt = () => (retryAt > now() ? retryAt : undefined)
  return get
}
