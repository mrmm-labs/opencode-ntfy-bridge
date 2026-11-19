import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"

import { logPath } from "./paths.ts"
import { filterSecrets } from "./filter.ts"

const MAX_BYTES = 1_000_000

let chain: Promise<void> = Promise.resolve()
let ready: string | undefined

/**
 * Appends one JSON line, asynchronously and in order; logging never throws.
 * Every line goes through the secret filter. Nothing is written to stdout or
 * stderr, which the TUI owns.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const path = logPath()
  const line = filterSecrets(
    `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`,
  )
  chain = chain
    .then(async () => {
      if (ready !== path) {
        await mkdir(dirname(path), { recursive: true })
        try {
          if ((await stat(path)).size > MAX_BYTES)
            await rename(path, `${path}.1`)
        } catch {}
        ready = path
      }
      await appendFile(path, line)
    })
    .catch(() => {})
}

/** Resolves once every queued line is written. */
export function flushLog(): Promise<void> {
  return chain
}
