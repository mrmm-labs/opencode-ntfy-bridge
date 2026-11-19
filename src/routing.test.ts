import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Rule } from "./config.ts"
import { globToRegExp, Router, runClassifier } from "./routing.ts"

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const router = (rules: Rule[], classify = async () => true) => {
  const c = clock(1_000_000)
  return { c, r: new Router({ away: { minutes: 10 }, rules }, classify, c.now) }
}

describe("globToRegExp", () => {
  it("matches ** across segments and * within one", () => {
    assert.ok(globToRegExp("**/app").test("/srv/src/app"))
    assert.ok(globToRegExp("**/app").test("app"))
    assert.ok(!globToRegExp("**/app").test("/src/app2"))
    assert.ok(globToRegExp("/src/*/app").test("/src/x/app"))
    assert.ok(!globToRegExp("/src/*/app").test("/src/x/y/app"))
    assert.ok(globToRegExp("/src/a.b?").test("/src/a.bc"))
    assert.ok(!globToRegExp("/src/a.b").test("/src/aXb"))
  })
})

describe("Router", () => {
  it("routes nothing until the operator is away, then everything without rules", async () => {
    const { c, r } = router([])
    assert.equal(await r.routes({ id: "s" }), false)
    c.advance(10 * 60_000)
    assert.equal(r.away(), true)
    assert.equal(await r.routes({ id: "s" }), true)
    r.touch()
    assert.equal(await r.routes({ id: "s" }), false)
  })

  it("manual on/off beats away", async () => {
    const { c, r } = router([])
    r.set("s", true)
    assert.equal(await r.routes({ id: "s" }), true)
    assert.equal(r.mode("s"), "on")
    c.advance(11 * 60_000)
    r.set("s", false)
    assert.equal(await r.routes({ id: "s" }), false)
    r.set("s", undefined)
    assert.equal(r.mode("s"), "auto")
    assert.equal(await r.routes({ id: "s" }), true)
  })

  it("applies agent, directory and command rules when away", async () => {
    const calls: string[] = []
    const { c, r } = router(
      [{ agent: /^coordinator$/ }, { directory: "**/app" }, { command: ["x"] }],
      async (_argv, s) => {
        calls.push(s.id)
        return s.id === "cmd"
      },
    )
    c.advance(10 * 60_000)
    assert.equal(await r.routes({ id: "a", agent: "coordinator" }), true)
    assert.equal(await r.routes({ id: "d", directory: "/w/app" }), true)
    assert.equal(await r.routes({ id: "cmd" }), true)
    assert.equal(
      await r.routes({ id: "no", agent: "build", directory: "/w/x" }),
      false,
    )
    await r.routes({ id: "no" })
    assert.deepEqual(
      calls.filter((x) => x === "no").length,
      1,
      "classifier cached",
    )
  })

  it("runs a classifier command asynchronously by exit code", async () => {
    assert.equal(await runClassifier(["true"], { id: "s" }), true)
    assert.equal(await runClassifier(["false"], { id: "s" }), false)
    assert.equal(
      await runClassifier(
        ["sh", "-c", 'test "$OOB_BRIDGE_AGENT" = coordinator'],
        {
          id: "s",
          agent: "coordinator",
        },
      ),
      true,
    )
    assert.equal(await runClassifier(["/nonexistent/cmd"], { id: "s" }), false)
  })
})
