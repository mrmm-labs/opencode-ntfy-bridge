import assert from "node:assert/strict"
import { createServer } from "node:net"
import { describe, it } from "node:test"

import { fakeNtfy } from "./fake-ntfy.test-util.ts"
import { registerSecret } from "../filter.ts"
import { Ntfy, type Incoming } from "./ntfy.ts"

const topics = { out: "oc-out", in: "oc-in" }

describe("Ntfy.publish", () => {
  it("posts JSON to the root with the token and filters secrets", async () => {
    const f = await fakeNtfy()
    registerSecret("tk_unit_test_token_value_123456")
    const n = new Ntfy({
      server: f.url,
      topics,
      token: async () => "tk_unit_test_token_value_123456",
    })
    const id = await n.publish({
      title: "t",
      message: "here: tk_unit_test_token_value_123456 and password=abcd1234",
      priority: 4,
      tags: ["question"],
      actions: [
        {
          action: "http",
          label: "Yes",
          url: `${f.url}/oc-in`,
          method: "POST",
          body: "{}",
        },
      ],
    })
    assert.equal(id, "m1")
    const p = f.published[0]
    assert.equal(p.auth, "Bearer tk_unit_test_token_value_123456")
    assert.equal(p.body.topic, "oc-out")
    assert.equal(p.body.priority, 4)
    assert.doesNotMatch(String(p.body.message), /tk_unit|abcd1234/)
    assert.equal((p.body.actions as Array<{ label: string }>)[0].label, "Yes")
    await f.close()
  })

  it("actionAuth puts the token in each http action, and only then", async () => {
    const f = await fakeNtfy()
    const action = {
      action: "http" as const,
      label: "Yes",
      url: `${f.url}/oc-in`,
      method: "POST" as const,
      body: "{}",
    }
    for (const actionAuth of [true, false]) {
      await new Ntfy({
        server: f.url,
        topics,
        actionAuth,
        token: async () => "tk_action_token",
      }).publish({ message: "m", actions: [action] })
    }
    await new Ntfy({ server: f.url, topics, actionAuth: true }).publish({
      message: "m",
      actions: [action],
    })
    const h = f.published.map(
      (p) => (p.body.actions as Array<{ headers?: unknown }>)[0].headers,
    )
    assert.deepEqual(h, [
      { Authorization: "Bearer tk_action_token" },
      undefined,
      undefined,
    ])
    await f.close()
  })

  it("returns undefined, never throws, when the server fails or is unreachable", async () => {
    const f = await fakeNtfy()
    f.failPublish = true
    assert.equal(
      await new Ntfy({ server: f.url, topics }).publish({ message: "x" }),
      undefined,
    )
    await f.close()
    const dead = await freePort()
    const n = new Ntfy({
      server: `http://127.0.0.1:${dead}`,
      topics,
      timeoutMs: 500,
    })
    assert.equal(await n.publish({ message: "x" }), undefined)
  })

  it("keeps working when the token command fails", async () => {
    const f = await fakeNtfy()
    const n = new Ntfy({
      server: f.url,
      topics,
      token: async () => {
        throw new Error("no store")
      },
    })
    assert.equal(await n.publish({ message: "x" }), "m1")
    assert.equal(f.published[0].auth, undefined)
    await f.close()
  })
})

describe("Ntfy.subscribe", () => {
  it("streams messages and resumes with since=<last id> after a drop", async () => {
    const f = await fakeNtfy()
    const n = new Ntfy({
      server: f.url,
      topics,
      backoff: { min: 20, max: 100 },
    })
    const got: Incoming[] = []
    const ac = new AbortController()
    const done = n.subscribe((m) => got.push(m), ac.signal)
    await f.waitFor(() => f.subscribes.length === 1)
    assert.equal(f.subscribes[0].url, "/oc-in/json")
    f.send("a1", "#abcd 1")
    await f.waitFor(() => got.length === 1)
    assert.equal(got[0].message, "#abcd 1")
    f.drop()
    await f.waitFor(() => f.subscribes.length === 2)
    assert.equal(f.subscribes[1].url, "/oc-in/json?since=a1")
    ac.abort()
    await done
    await f.close()
  })

  it("retries with backoff while the server is down", async () => {
    const port = await freePort()
    let calls = 0
    const n = new Ntfy({
      server: `http://127.0.0.1:${port}`,
      topics,
      backoff: { min: 10, max: 40 },
      fetch: (async (...args: Parameters<typeof fetch>) => {
        calls++
        return fetch(...args)
      }) as typeof fetch,
    })
    const ac = new AbortController()
    const done = n.subscribe(() => {}, ac.signal, "1700000000")
    await new Promise((r) => setTimeout(r, 200))
    ac.abort()
    await done
    assert.ok(calls >= 3, `reconnected ${calls} times`)
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}
