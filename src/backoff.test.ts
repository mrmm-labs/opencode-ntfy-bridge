import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { fakeNtfy } from "./connectors/fake-ntfy.test-util.ts"
import { fakeTelegram } from "./connectors/fake-telegram.test-util.ts"
import { Ntfy } from "./connectors/ntfy.ts"
import { TelegramConnector } from "./connectors/telegram.ts"
import { flushLog } from "./logger.ts"
import { lazyToken, TokenUnavailable, type TokenFn } from "./token.ts"
import { sleep } from "./util.ts"

const WAITING = /waiting for token \(retry \d\d:\d\d\)/

/** A token function that is unavailable for `ms` after each call, counting calls. */
const stuck = (ms: number) => {
  const state = { calls: 0, at: 0 }
  const fn: TokenFn = async () => {
    state.calls++
    state.at = Date.now() + ms
    throw new TokenUnavailable(state.at)
  }
  fn.retryAt = () => (state.at > Date.now() ? state.at : undefined)
  return { fn, state }
}

describe("lazyToken backoff", () => {
  it("retries after 30 s, 1 min, 2 min, then every 5 min, and logs once per step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oobb-tok-"))
    const count = join(dir, "count")
    const go = join(dir, "go")
    const logFile = join(dir, "bridge.log")
    const keep = process.env.OPENCODE_OOB_BRIDGE_LOG
    process.env.OPENCODE_OOB_BRIDGE_LOG = logFile
    try {
      const clock = { t: 1_000_000 }
      const token = lazyToken(
        {
          command: [
            "sh",
            "-c",
            `echo x >> '${count}'; test -f '${go}' && echo tok-value-1234 || exit 1`,
          ],
        },
        () => clock.t,
      )
      const runs = async () =>
        (await readFile(count, "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean).length
      for (const wait of [30, 60, 120, 300, 300]) {
        const err = await token().catch((e) => e)
        assert.ok(err instanceof TokenUnavailable)
        assert.equal(err.retryAt, clock.t + wait * 1000)
        assert.equal(token.retryAt!(), clock.t + wait * 1000)
        // Calls inside the window do not run the command, and are not logged.
        for (let i = 0; i < 20; i++) {
          clock.t += 1000
          const again = await token().catch((e) => e)
          assert.ok(again instanceof TokenUnavailable)
          assert.match(again.message, WAITING)
          if (clock.t >= err.retryAt) break
        }
        clock.t = err.retryAt - 1
        const early = await token().catch((e) => e)
        assert.ok(early instanceof TokenUnavailable)
        clock.t = err.retryAt
        if (wait === 30) assert.equal(await runs(), 1)
      }
      assert.equal(await runs(), 5, "one run per step, however many callers")
      await flushLog()
      const lines = (await readFile(logFile, "utf8"))
        .split("\n")
        .filter((l) => l.includes("token_unavailable"))
        .map((l) => JSON.parse(l))
      assert.deepEqual(
        lines.map((l) => l.retry_in_s),
        [30, 60, 120, 300, 300],
      )
      assert.deepEqual(
        lines.map((l) => l.attempt),
        [1, 2, 3, 4, 5],
      )

      await writeFile(go, "")
      assert.equal(await token(), "tok-value-1234")
      assert.equal(token.retryAt!(), undefined)
      assert.equal(await token(), "tok-value-1234", "cached")
      assert.equal(await runs(), 6)
    } finally {
      if (keep === undefined) delete process.env.OPENCODE_OOB_BRIDGE_LOG
      else process.env.OPENCODE_OOB_BRIDGE_LOG = keep
    }
  })
})

/** Polls until `fn` holds: the wait text only shows between two tries, so one look can miss it under load. */
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await sleep(10)
}

/** Waits for the second try, then counts the tries over a stretch much longer than a fast loop would need. */
async function triesAfterSecond(state: { calls: number }) {
  const until = Date.now() + 5000
  while (state.calls < 2 && Date.now() < until) await sleep(20)
  const before = state.calls
  await sleep(600)
  return { before, during: state.calls - before }
}

describe("Telegram while the token is unavailable", () => {
  it("does not loop fast, and shows when it will retry", async () => {
    const tg = await fakeTelegram()
    const { fn, state } = stuck(250)
    const c = new TelegramConnector({
      token: fn,
      chatId: "5",
      apiBase: tg.url,
      pollSeconds: 1,
      backoff: { min: 5, max: 10 },
    })
    const ac = new AbortController()
    try {
      c.start(async () => undefined, ac.signal)
      const { before, during } = await triesAfterSecond(state)
      assert.ok(before >= 2, `${before} tries`)
      // A fast loop at 5-10 ms would make dozens; one try per 250 ms makes about two.
      assert.ok(during <= 6, `${during} tries in 600 ms`)
      await until(() => WAITING.test(c.status().lastError ?? ""))
      assert.match(c.status().lastError ?? "", WAITING)
      assert.equal(c.status().connected, false)
    } finally {
      ac.abort()
      await tg.close()
    }
  })
})

describe("ntfy while the token is unavailable", () => {
  it("does not subscribe anonymously or loop fast, and shows the wait", async () => {
    const f = await fakeNtfy()
    const { fn, state } = stuck(250)
    const n = new Ntfy({
      server: f.url,
      topics: { out: "o", in: "i" },
      token: fn,
      backoff: { min: 5, max: 10 },
    })
    const ac = new AbortController()
    const done = n.subscribe(() => {}, ac.signal)
    try {
      const { before, during } = await triesAfterSecond(state)
      assert.ok(before >= 2, `${before} tries`)
      assert.ok(during <= 6, `${during} tries in 600 ms`)
      assert.equal(f.subscribes.length, 0, "no anonymous subscription")
      await until(() => WAITING.test(n.error() ?? ""))
      assert.match(n.error() ?? "", WAITING)
    } finally {
      ac.abort()
      await done
      await f.close()
    }
  })
})
