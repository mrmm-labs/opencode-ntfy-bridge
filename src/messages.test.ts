import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseConfig, type Config } from "./config.ts"
import { DEFAULTS, format, parseFormats, parseProfiles } from "./messages.ts"

describe("messages", () => {
  it("fills placeholders, drops empty tags, renders unknown names empty", () => {
    const f = format("question", {
      project: "shop",
      agent: "builder",
      subagent: "",
      thread: "",
      body: "Ship?",
      hint: "Tap",
    })
    assert.equal(f.title, "shop · builder asks")
    assert.equal(f.message, "Ship?\n\nTap")
    assert.deepEqual(f.tags, ["question"])
    assert.equal(f.priority, DEFAULTS.question.priority)
    assert.equal(
      format("notice", {}, { notice: { message: "{{nope}}x" } }).message,
      "x",
    )
  })

  it("layers defaults, config messages, then the first matching profile", () => {
    const c = parseConfig({
      server: "https://n.example",
      topics: { out: "a", in: "b" },
      messages: { finished: { title: "done: {{project}}", priority: 3 } },
      profiles: [
        { agent: "^coordinator$", messages: { finished: { priority: 5 } } },
        { directory: "**/shop", messages: { finished: { title: "shop!" } } },
      ],
    }) as Config
    const run = (agent: string, directory: string) =>
      format("finished", { project: "p" }, c.messages, c.profiles, {
        agent,
        directory,
      })
    assert.deepEqual(
      [run("build", "/w/x").title, run("build", "/w/x").priority],
      ["done: p", 3],
    )
    assert.deepEqual(
      [
        run("coordinator", "/w/shop").title,
        run("coordinator", "/w/shop").priority,
      ],
      ["done: p", 5],
    )
    assert.equal(run("build", "/w/shop").title, "shop!")
  })

  it("rejects bad formats and profiles", () => {
    assert.equal(typeof parseFormats({ bogus: {} }, "messages"), "string")
    assert.equal(
      typeof parseFormats({ notice: { priority: 9 } }, "m"),
      "string",
    )
    assert.equal(typeof parseFormats({ notice: { tags: [1] } }, "m"), "string")
    assert.equal(typeof parseProfiles([{ messages: {} }]), "string")
    assert.equal(typeof parseProfiles([{ agent: "(" }]), "string")
  })
})
