// A tiny in-process stand-in for an ntfy server, for unit tests.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

export type Published = { body: Record<string, unknown>; auth?: string }

export async function fakeNtfy() {
  const published: Published[] = []
  const subscribes: Array<{ url: string; auth?: string }> = []
  const streams = new Set<ServerResponse>()
  let seq = 0
  let failPublish = false

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/") {
      let data = ""
      req.on("data", (c) => (data += c))
      req.on("end", () => {
        if (failPublish) {
          res.writeHead(500).end()
          return
        }
        published.push({
          body: JSON.parse(data),
          auth: req.headers.authorization,
        })
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: `m${++seq}` }))
      })
      return
    }
    if (req.method === "GET" && /\/json(\?|$)/.test(req.url ?? "")) {
      subscribes.push({ url: req.url ?? "", auth: req.headers.authorization })
      res.writeHead(200, { "Content-Type": "application/x-ndjson" })
      res.write(`${JSON.stringify({ id: "open1", event: "open" })}\n`)
      streams.add(res)
      req.on("close", () => streams.delete(res))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    published,
    subscribes,
    set failPublish(v: boolean) {
      failPublish = v
    },
    /** Sends one inbound message to every open subscriber. */
    send(id: string, message: string, time = Math.floor(Date.now() / 1000)) {
      for (const s of streams)
        s.write(
          `${JSON.stringify({ id, time, event: "message", topic: "in", message })}\n`,
        )
    },
    /** Drops open subscriber connections. */
    drop() {
      for (const s of streams) s.destroy()
      streams.clear()
    },
    async waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
      const end = Date.now() + ms
      for (;;) {
        const v = fn()
        if (v) return v
        if (Date.now() > end) throw new Error("timed out")
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of streams) s.destroy()
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
