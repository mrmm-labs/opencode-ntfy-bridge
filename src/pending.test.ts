import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { PendingStore, type Pending } from "./pending.ts"

const entry = (id: string, askedAt: number): Pending => ({
  id,
  kind: "question",
  requestID: `frm_${id}`,
  sessionID: "s",
  rootSessionID: "s",
  title: "t",
  askedAt,
  state: "pending",
})

describe("PendingStore", () => {
  it("persists, reloads the latest state and drops entries older than a day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-pending-"))
    const file = join(dir, "sub", "pending.jsonl")
    const now = Date.now()
    const a = new PendingStore(file)
    a.put(entry("aaaa", now))
    a.put(entry("old1", now - 25 * 3600_000))
    a.update("aaaa", {
      state: "answered",
      answeredBy: "phone",
      answeredAt: now,
    })
    await a.flush()
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 3)

    const b = new PendingStore(file)
    await b.load(now)
    assert.equal(b.get("aaaa")?.state, "answered")
    assert.equal(b.get("old1"), undefined)
    assert.equal(b.byRequest("frm_aaaa")?.id, "aaaa")
    await b.flush()
    assert.equal(
      (await readFile(file, "utf8")).trim().split("\n").length,
      1,
      "compacted",
    )
  })

  it("survives a missing or corrupt file and works without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ntfyb-pending-"))
    const file = join(dir, "pending.jsonl")
    await new PendingStore(file).load()
    await writeFile(file, "not json\n")
    const s = new PendingStore(file)
    await s.load()
    assert.deepEqual(s.list(), [])
    const mem = new PendingStore()
    mem.put(entry("bbbb", Date.now()))
    assert.equal(mem.get("bbbb")?.id, "bbbb")
    assert.match(mem.newId(), /^[a-z0-9]{4}$/)
  })
})
