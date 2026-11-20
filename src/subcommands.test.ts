import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  bind,
  complete,
  dispatch,
  fuzzy,
  helpMarkdown,
  helpText,
  parse,
  sub,
  type Ui,
  type Values,
} from "./subcommands.ts"

const ran: Array<[string, Values]> = []
const mk = (
  name: string,
  args: Parameters<typeof sub>[0]["args"] = [],
  extra = {},
) =>
  sub({
    name,
    title: name.toUpperCase(),
    description: `does ${name}`,
    group: "G",
    args,
    run: (v) => void ran.push([name, v]),
    ...extra,
  })

const mode = {
  name: "mode",
  kind: "enum" as const,
  title: "Which mode?",
  placeholder: "fast|slow",
  options: () => [
    { value: "fast", title: "Fast", description: "quickly" },
    { value: "slow", title: "Slow" },
  ],
  current: () => "slow",
}
const note = {
  name: "note",
  kind: "text" as const,
  title: "A note",
  placeholder: "text",
  default: () => "hello",
}
const cmds = [
  mk("on"),
  mk("off"),
  mk("set", [mode, { ...note, name: "tag", default: undefined }]),
  mk("chat", [mode]),
  mk("channel", [mode]),
  mk("pick", [{ ...mode, optional: true, noneTitle: "Whatever" }]),
]

function fakeUi(answers: Array<string | undefined>) {
  const dialogs: Array<Record<string, any>> = []
  const toasts: string[] = []
  const ui: Ui = {
    select: async (o) => (
      dialogs.push({ kind: "select", ...o }), answers.shift() as never
    ),
    prompt: async (o) => (
      dialogs.push({ kind: "prompt", ...o }), answers.shift()
    ),
    toast: (m) => void toasts.push(m),
  }
  return { ui, dialogs, toasts }
}

describe("sub", () => {
  it("builds the usage line from the arguments", () => {
    assert.equal(mk("on").usage, "/oob on")
    assert.equal(cmds[2].usage, "/oob set <fast|slow> <text>")
    assert.equal(cmds[5].usage, "/oob pick [<fast|slow>]")
  })
})

describe("parse", () => {
  it("nothing typed is the picker", () => {
    assert.deepEqual(parse("", cmds), { kind: "empty" })
    assert.deepEqual(parse("   ", cmds), { kind: "empty" })
    assert.deepEqual(parse(undefined, cmds), { kind: "empty" })
  })

  it("a full form binds its arguments, whatever the case", () => {
    const p = parse("  CHAT   Fast ", cmds)
    assert.equal(p.kind, "command")
    if (p.kind !== "command") return
    assert.equal(p.cmd.name, "chat")
    assert.deepEqual(p.values, { mode: "fast" })
    assert.deepEqual(p.extra, [])
    assert.equal(p.typed, true)
  })

  it("a partial form has no value for what is missing", () => {
    const p = parse("set fast", cmds)
    if (p.kind !== "command") throw new Error("command")
    assert.deepEqual(p.values, { mode: "fast" })
    assert.equal(p.invalid, undefined)
  })

  it("the last text argument takes the rest of the words", () => {
    const p = parse("set slow a b  c", cmds)
    if (p.kind !== "command") throw new Error("command")
    assert.deepEqual(p.values, { mode: "slow", tag: "a b c" })
    assert.deepEqual(p.extra, [])
  })

  it("a name that fits one sub-command is enough; an exact name wins over a longer one", () => {
    const one = parse("au", [mk("auto"), mk("off")])
    assert.equal(one.kind === "command" && one.cmd.name, "auto")
    const exact = parse("on", [mk("on"), mk("online")])
    assert.equal(exact.kind === "command" && exact.cmd.name, "on")
  })

  it("a prefix that fits several is ambiguous, and keeps the other words", () => {
    const p = parse("ch fast", cmds)
    assert.equal(p.kind, "ambiguous")
    if (p.kind !== "ambiguous") return
    assert.deepEqual(
      p.matches.map((c) => c.name),
      ["chat", "channel"],
    )
    assert.deepEqual(p.rest, ["fast"])
    const o = parse("o", cmds)
    assert.equal(o.kind === "ambiguous" && o.matches.length, 2)
  })

  it("an unknown name says so", () => {
    assert.deepEqual(parse("zzz", cmds), { kind: "unknown", word: "zzz" })
  })

  it("an invalid value is kept apart, and extra words are counted", () => {
    const bad = parse("chat turbo", cmds)
    if (bad.kind !== "command") throw new Error("command")
    assert.equal(bad.invalid?.given, "turbo")
    assert.equal(bad.invalid?.arg.name, "mode")
    assert.deepEqual(bad.values, {})
    const extra = parse("chat fast now please", cmds)
    if (extra.kind !== "command") throw new Error("command")
    assert.deepEqual(extra.extra, ["now", "please"])
    const none = parse("on now", cmds)
    if (none.kind !== "command") throw new Error("command")
    assert.deepEqual(none.extra, ["now"])
  })
})

describe("complete", () => {
  it("asks only what is missing: an enum by select, with the current one marked", async () => {
    const { ui, dialogs } = fakeUi(["fast"])
    const v = await complete(ui, bind(cmds[3], []), "required")
    assert.deepEqual(v, { mode: "fast" })
    assert.equal(dialogs.length, 1)
    assert.equal(dialogs[0].kind, "select")
    assert.equal(dialogs[0].title, "Which mode?")
    assert.equal(dialogs[0].current, "slow")
    assert.deepEqual(
      dialogs[0].options.map((o: any) => o.value),
      ["fast", "slow"],
    )
  })

  it("asks a free argument by prompt, with its placeholder and default", async () => {
    const mine = mk("note", [note])
    const { ui, dialogs } = fakeUi(["  hi there "])
    const v = await complete(ui, bind(mine, []), "all")
    assert.deepEqual(v, { note: "hi there" })
    assert.equal(dialogs[0].kind, "prompt")
    assert.equal(dialogs[0].placeholder, "text")
    assert.equal(dialogs[0].value, "hello")
  })

  it("walks several arguments in order, skipping the ones given", async () => {
    const { ui, dialogs } = fakeUi(["note it"])
    const v = await complete(ui, bind(cmds[2], ["fast"]), "required")
    assert.deepEqual(v, { mode: "fast", tag: "note it" })
    assert.deepEqual(
      dialogs.map((d) => d.kind),
      ["prompt"],
    )
  })

  it("Esc at any step cancels and returns nothing", async () => {
    const a = fakeUi([undefined])
    assert.equal(await complete(a.ui, bind(cmds[3], []), "all"), undefined)
    const b = fakeUi(["fast", undefined])
    assert.equal(await complete(b.ui, bind(cmds[2], []), "all"), undefined)
    assert.equal(b.dialogs.length, 2)
  })

  it("an empty answer to a needed text is refused and asked again; an optional one is left out", async () => {
    const needed = fakeUi(["", "ok"])
    const v = await complete(
      needed.ui,
      bind(mk("n", [{ ...note, default: undefined }]), []),
      "required",
    )
    assert.deepEqual(v, { note: "ok" })
    assert.equal(needed.toasts.length, 1)
    const optional = fakeUi([""])
    const w = await complete(
      optional.ui,
      bind(mk("n", [{ ...note, default: undefined, optional: true }]), []),
      "all",
    )
    assert.deepEqual(w, {})
  })

  it("an optional argument is left out when typed, and offered with a none choice from the picker", async () => {
    const typed = fakeUi([])
    assert.deepEqual(
      await complete(typed.ui, bind(cmds[5], []), "required"),
      {},
    )
    assert.equal(typed.dialogs.length, 0)
    const picked = fakeUi([""])
    assert.deepEqual(await complete(picked.ui, bind(cmds[5], []), "all"), {})
    assert.deepEqual(
      picked.dialogs[0].options.map((o: any) => [o.value, o.title]),
      [
        ["", "Whatever"],
        ["fast", "Fast"],
        ["slow", "Slow"],
      ],
    )
    assert.equal(picked.dialogs[0].current, "slow")
    const chosen = fakeUi(["fast"])
    assert.deepEqual(await complete(chosen.ui, bind(cmds[5], []), "all"), {
      mode: "fast",
    })
  })

  it("a default fills a missing value typed, and from the picker when there is nothing to choose", async () => {
    const only = mk("p", [
      {
        ...mode,
        options: () => [{ value: "x", title: "x" }],
        default: () => "x",
      },
    ])
    const typed = fakeUi([])
    assert.deepEqual(await complete(typed.ui, bind(only, []), "required"), {
      mode: "x",
    })
    assert.equal(typed.dialogs.length, 0)
    const picker = fakeUi([])
    assert.deepEqual(await complete(picker.ui, bind(only, []), "all"), {
      mode: "x",
    })
    assert.equal(picker.dialogs.length, 0)
    const two = mk("p", [{ ...mode, default: () => "fast" }])
    const asked = fakeUi(["slow"])
    assert.deepEqual(await complete(asked.ui, bind(two, []), "all"), {
      mode: "slow",
    })
  })

  it("an invalid typed value is named with the valid ones, and that picker opens", async () => {
    const { ui, dialogs, toasts } = fakeUi(["slow"])
    const v = await complete(ui, bind(cmds[3], ["turbo"]), "required")
    assert.deepEqual(v, { mode: "slow" })
    assert.deepEqual(toasts, ['"turbo" is not a mode. Use: fast, slow'])
    assert.equal(dialogs.length, 1)
  })

  it("an enum with no choices is left for the command to explain", async () => {
    const none = mk("e", [{ ...mode, options: () => [] }])
    const { ui, dialogs } = fakeUi([])
    assert.deepEqual(await complete(ui, bind(none, []), "all"), {})
    assert.equal(dialogs.length, 0)
  })
})

describe("dispatch", () => {
  const run = async (
    input: string | undefined,
    answers: Array<string | undefined> = [],
    list = cmds,
  ) => {
    ran.length = 0
    const f = fakeUi(answers)
    await dispatch(f.ui, "T", list, input)
    return { ...f, ran: [...ran] }
  }

  it("a complete typed form runs with no dialog", async () => {
    const r = await run("chat fast")
    assert.deepEqual(r.ran, [["chat", { mode: "fast" }]])
    assert.equal(r.dialogs.length, 0)
  })

  it("nothing typed: a picker of every sub-command with its description, usage and group, then the arguments", async () => {
    const r = await run("", ["chat", "slow"])
    const top = r.dialogs[0]
    assert.equal(top.title, "T")
    assert.deepEqual(
      top.options.map((o: any) => o.value),
      cmds.map((c) => c.name),
    )
    assert.deepEqual(
      [
        top.options[3].description,
        top.options[3].footer,
        top.options[3].category,
      ],
      ["does chat", "/oob chat <fast|slow>", "G"],
    )
    assert.equal(typeof top.search, "function")
    assert.deepEqual(r.ran, [["chat", { mode: "slow" }]])
  })

  it("Esc at the picker runs nothing", async () => {
    const r = await run("", [undefined])
    assert.deepEqual(r.ran, [])
    assert.equal(r.toasts.length, 0)
  })

  it("an ambiguous prefix opens a picker of just the matches, and keeps the typed arguments", async () => {
    const r = await run("ch fast", ["channel"])
    assert.deepEqual(
      r.dialogs[0].options.map((o: any) => o.value),
      ["chat", "channel"],
    )
    assert.equal(r.dialogs.length, 1)
    assert.deepEqual(r.ran, [["channel", { mode: "fast" }]])
  })

  it("an unknown name says so and opens the whole picker", async () => {
    const r = await run("zzz", [undefined])
    assert.match(r.toasts[0], /No sub-command "zzz"/)
    assert.equal(r.dialogs[0].options.length, cmds.length)
  })

  it("an invalid value toasts the valid ones and reopens that picker", async () => {
    const r = await run("chat turbo", ["fast"])
    assert.equal(r.toasts[0], '"turbo" is not a mode. Use: fast, slow')
    assert.deepEqual(r.ran, [["chat", { mode: "fast" }]])
  })

  it("extra words give the usage and run nothing", async () => {
    const r = await run("off now")
    assert.deepEqual(r.toasts, ["Usage: /oob off"])
    assert.deepEqual(r.ran, [])
  })

  it("a sub-command that cannot run now says why before asking anything", async () => {
    const list = [mk("x", [mode], { unavailable: () => "Not now" })]
    const r = await run("x", [], list)
    assert.deepEqual(r.toasts, ["Not now"])
    assert.equal(r.dialogs.length, 0)
  })

  it("a cancelled argument has no side effect", async () => {
    const r = await run("chat", [undefined])
    assert.deepEqual(r.ran, [])
  })
})

describe("fuzzy", () => {
  const items = [
    { value: "status", title: "Status", description: "show channels" },
    { value: "sidebar", title: "Sidebar section", description: "size" },
    { value: "delivery", title: "Replies", description: "how messages arrive" },
  ]
  it("keeps the order for an empty query", () => {
    assert.deepEqual(
      fuzzy("", items).map((i) => i.value),
      ["status", "sidebar", "delivery"],
    )
  })
  it("ranks a name prefix before a word in the description, and drops non-matches", () => {
    assert.deepEqual(
      fuzzy("s", items).map((i) => i.value),
      ["status", "sidebar", "delivery"],
    )
    assert.deepEqual(
      fuzzy("arrive", items).map((i) => i.value),
      ["delivery"],
    )
    assert.deepEqual(
      fuzzy("stts", items).map((i) => i.value),
      ["status"],
    )
    assert.deepEqual(fuzzy("zzz", items), [])
  })
})

describe("help", () => {
  it("lists every sub-command with its usage, aligned", () => {
    const lines = helpText(cmds).split("\n")
    assert.ok(lines[0].startsWith("/oob on "))
    assert.ok(lines[0].endsWith("does on"))
    assert.equal(lines.filter((l) => l.includes("  does ")).length, cmds.length)
    const col = lines[0].indexOf("does on")
    for (const l of lines.slice(0, cmds.length))
      assert.equal(l.indexOf("does "), col)
  })

  it("makes a markdown table with one row per sub-command", () => {
    const md = helpMarkdown(cmds).split("\n")
    assert.equal(md.length, cmds.length + 2)
    assert.equal(md[2], "| `/oob on` | does on |")
    assert.equal(md[7], "| `/oob pick [<fast\\|slow>]` | does pick |")
  })
})
