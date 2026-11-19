import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { registerSecret } from "./filter.ts"
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

/** Resolves once and caches; a failed command is retried on the next call. */
export function lazyToken(
  source: TokenSource | undefined,
): () => Promise<string | undefined> {
  let token: Promise<string | undefined> | undefined
  return () =>
    (token ??= resolveToken(source).catch((err) => {
      token = undefined
      throw err
    }))
}
