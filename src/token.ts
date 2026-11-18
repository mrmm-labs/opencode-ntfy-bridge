import { execFile } from "node:child_process"
import { promisify } from "node:util"

import type { TokenSource } from "./config.ts"
import { registerSecret } from "./filter.ts"

const run = promisify(execFile)

/**
 * Resolves the ntfy token from the environment or a command (run async, never
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
