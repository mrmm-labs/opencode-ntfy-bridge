/** Minimal ntfy client: JSON publish and a reconnecting JSON-stream subscription. */
import { filterSecrets } from "./filter.ts"
import { log } from "./logger.ts"

export type HttpAction = {
  action: "http"
  label: string
  url: string
  method: "POST"
  body: string
  headers?: Record<string, string>
  clear?: boolean
}

export type Publish = {
  title?: string
  message: string
  tags?: string[]
  priority?: 1 | 2 | 3 | 4 | 5
  actions?: HttpAction[]
  /** Updates the earlier notification with this id instead of adding one. */
  sequence_id?: string
}

export type Incoming = { id: string; time: number; message: string }

export type NtfyOptions = {
  server: string
  topics: { out: string; in: string }
  token?: () => Promise<string | undefined>
  /** Puts the token in each http action, so buttons work on a server that denies anonymous writes. */
  actionAuth?: boolean
  fetch?: typeof fetch
  /** Reconnect delays in ms: first and cap. */
  backoff?: { min: number; max: number }
  timeoutMs?: number
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    t.unref?.()
    function done() {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })

export class Ntfy {
  private readonly fetch: typeof fetch
  private readonly opts: NtfyOptions
  constructor(opts: NtfyOptions) {
    this.opts = opts
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  private async headers(json: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = json
      ? { "Content-Type": "application/json" }
      : {}
    let token: string | undefined
    try {
      token = await this.opts.token?.()
    } catch (err) {
      log("token_error", { message: (err as Error).message })
    }
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }

  /** Publishes to the out topic. Returns the message id; never throws. */
  async publish(p: Publish): Promise<string | undefined> {
    const headers = await this.headers(true)
    const auth =
      this.opts.actionAuth && headers.Authorization
        ? { headers: { Authorization: headers.Authorization } }
        : {}
    const body = {
      ...p,
      topic: this.opts.topics.out,
      title: p.title === undefined ? undefined : filterSecrets(p.title),
      message: filterSecrets(p.message),
      actions: p.actions?.map((a) => ({
        ...a,
        label: filterSecrets(a.label),
        ...auth,
      })),
    }
    try {
      const res = await this.fetch(`${this.opts.server}/`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // A pooled socket the proxy has already dropped hangs until the
        // timeout; pushes are rare, so each one opens a fresh connection.
        keepalive: false,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      })
      if (!res.ok) {
        log("publish_failed", { status: res.status })
        await res.body?.cancel()
        return undefined
      }
      const out = (await res.json()) as { id?: string }
      return out.id
    } catch (err) {
      log("publish_error", { message: (err as Error).message })
      return undefined
    }
  }

  /**
   * Streams messages of the in topic until `signal` aborts. Reconnects with
   * exponential backoff and resumes with `since=<last id>`.
   */
  async subscribe(
    onMessage: (m: Incoming) => void,
    signal: AbortSignal,
    since?: string,
  ): Promise<void> {
    const { min, max } = this.opts.backoff ?? { min: 1000, max: 60_000 }
    let delay = min
    let last = since
    while (!signal.aborted) {
      try {
        const q = last ? `?since=${encodeURIComponent(last)}` : ""
        const res = await this.fetch(
          `${this.opts.server}/${this.opts.topics.in}/json${q}`,
          { headers: await this.headers(false), signal },
        )
        if (!res.ok || !res.body) {
          log("subscribe_failed", { status: res.status })
          await res.body?.cancel()
        } else {
          delay = min
          const decoder = new TextDecoder()
          let buf = ""
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            buf += decoder.decode(chunk, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line) continue
              let m: {
                event?: string
                id?: string
                time?: number
                message?: string
              }
              try {
                m = JSON.parse(line)
              } catch {
                continue
              }
              if (m.event !== "message" || typeof m.id !== "string") continue
              last = m.id
              try {
                onMessage({
                  id: m.id,
                  time: m.time ?? 0,
                  message: m.message ?? "",
                })
              } catch (err) {
                log("inbound_handler_error", {
                  message: (err as Error).message,
                })
              }
            }
          }
        }
      } catch (err) {
        if (signal.aborted) return
        log("subscribe_error", { message: (err as Error).message })
      }
      await sleep(delay, signal)
      delay = Math.min(max, delay * 2)
    }
  }
}
