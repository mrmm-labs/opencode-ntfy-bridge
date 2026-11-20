/**
 * The sub-commands of `/oob`, as data: one registry feeds the typed form, the
 * picker, `/oob help` and the README table. This file knows nothing of the host:
 * what a sub-command does, and the dialogs, are handed in.
 */

export type Values = Record<string, string | undefined>

export type Option = {
  value: string
  title: string
  description?: string
  disabled?: boolean
}

export type Arg = {
  name: string
  kind: "enum" | "text"
  /** The dialog title, and the question the dialog asks. */
  title: string
  /** In the usage line, and in the prompt of a text argument: `queue|steer|default`. */
  placeholder: string
  /** May be left out. A picker still offers the choice of giving one. */
  optional?: boolean
  /** The choice of giving none, for an optional enum. */
  noneTitle?: string
  /** The valid values, read when needed so they are the live ones. */
  options?: (given: Values) => Option[]
  /** The value in force now, to mark in the list. */
  current?: (given: Values) => string | undefined
  /** What a missing argument is when the answer is obvious. */
  default?: (given: Values) => string | undefined
}

export type SubCommand = {
  name: string
  title: string
  description: string
  /** Groups the picker. */
  group: string
  usage: string
  args: Arg[]
  /** Why it cannot run now, if it cannot. */
  unavailable?: () => string | undefined
  run: (values: Values) => void | Promise<void>
}

export const PREFIX = "/oob"

export function sub(
  c: Omit<SubCommand, "usage" | "args"> & { args?: Arg[] },
): SubCommand {
  const args = c.args ?? []
  const usage = [
    PREFIX,
    c.name,
    ...args.map((a) =>
      a.optional ? `[<${a.placeholder}>]` : `<${a.placeholder}>`,
    ),
  ].join(" ")
  return { ...c, args, usage }
}

export type Bound = {
  cmd: SubCommand
  values: Values
  /** A typed value that is not one of the choices. */
  invalid?: { arg: Arg; given: string }
  /** Words left over after the last argument. */
  extra: string[]
  /** Whether any argument was typed. */
  typed: boolean
}

/** Reads the words after a sub-command's name as its arguments. */
export function bind(cmd: SubCommand, words: string[]): Bound {
  const values: Values = {}
  let invalid: Bound["invalid"]
  let used = 0
  for (const arg of cmd.args) {
    const word = words[used]
    if (word === undefined) break
    if (arg.kind === "text") {
      values[arg.name] = words.slice(used).join(" ")
      used = words.length
      break
    }
    used++
    const hit = (arg.options?.(values) ?? []).find(
      (o) => o.value.toLowerCase() === word.toLowerCase(),
    )
    if (!hit) {
      invalid = { arg, given: word }
      break
    }
    values[arg.name] = hit.value
  }
  return {
    cmd,
    values,
    invalid,
    extra: invalid ? [] : words.slice(used),
    typed: words.length > 0,
  }
}

export type Parsed =
  | { kind: "empty" }
  | { kind: "unknown"; word: string }
  | { kind: "ambiguous"; word: string; matches: SubCommand[]; rest: string[] }
  | ({ kind: "command" } & Bound)

/** `chat on`, `ch on` when only one name starts that way, `chat` alone. */
export function parse(input: string | undefined, cmds: SubCommand[]): Parsed {
  const words = (input ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: "empty" }
  const [word, ...rest] = words
  const w = word.toLowerCase()
  const exact = cmds.find((c) => c.name === w)
  const matches = exact ? [exact] : cmds.filter((c) => c.name.startsWith(w))
  if (matches.length === 0) return { kind: "unknown", word }
  if (matches.length > 1) return { kind: "ambiguous", word, matches, rest }
  return { kind: "command", ...bind(matches[0], rest) }
}

const choices = (arg: Arg, given: Values) => arg.options?.(given) ?? []

/** The sentence for an invalid value. */
export function invalidText(arg: Arg, given: string, values: Values): string {
  return `"${given}" is not a ${arg.name}. Use: ${choices(arg, values)
    .map((o) => o.value)
    .join(", ")}`
}

export type Ui = {
  select<V>(o: {
    title: string
    options: Array<{
      title: string
      value: V
      description?: string
      footer?: string
      category?: string
      disabled?: boolean
    }>
    current?: V
    search?: (
      query: string,
      options: ReadonlyArray<{
        title: string
        value: V
        description?: string
      }>,
    ) => ReadonlyArray<{ title: string; value: V; description?: string }>
  }): Promise<V | undefined>
  prompt(o: {
    title: string
    description?: string
    placeholder?: string
    value?: string
  }): Promise<string | undefined>
  toast(
    message: string,
    variant?: "info" | "success" | "warning" | "error",
  ): void
}

/**
 * Asks for the arguments that are missing, one dialog each. `all` also offers
 * the optional ones (the picker); `required` leaves them out (the typed form).
 * Esc anywhere gives `undefined` and nothing has run.
 */
export async function complete(
  ui: Ui,
  b: Bound,
  ask: "all" | "required",
): Promise<Values | undefined> {
  const values = { ...b.values }
  for (const arg of b.cmd.args) {
    if (values[arg.name] !== undefined) continue
    const bad = b.invalid?.arg === arg ? b.invalid : undefined
    if (bad) ui.toast(invalidText(arg, bad.given, values), "warning")
    const opts = choices(arg, values)
    if (!bad) {
      const d = arg.default?.(values)
      const sure = arg.kind === "enum" && opts.length <= 1
      if (d !== undefined && (ask === "required" || sure)) {
        values[arg.name] = d
        continue
      }
      if (arg.optional && ask === "required") continue
    }
    if (arg.kind === "enum") {
      if (opts.length === 0) continue
      const none = arg.optional && !bad
      const pick = await ui.select<string>({
        title: arg.title,
        current: arg.current?.(values) ?? (none ? "" : undefined),
        options: [
          ...(none ? [{ title: arg.noneTitle ?? "Default", value: "" }] : []),
          ...opts,
        ],
      })
      if (pick === undefined) return undefined
      if (pick !== "") values[arg.name] = pick
      continue
    }
    for (;;) {
      const text = await ui.prompt({
        title: arg.title,
        placeholder: arg.placeholder,
        value: arg.default?.(values),
      })
      if (text === undefined) return undefined
      if (text.trim()) {
        values[arg.name] = text.trim()
        break
      }
      if (arg.optional) break
      ui.toast(`${arg.name} is needed`, "warning")
    }
  }
  return values
}

/** Subsequence match, best first; the name counts most. An empty query keeps the order. */
export function fuzzy<
  T extends { title: string; value: string; description?: string },
>(query: string, options: readonly T[]): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...options]
  const rank = (o: T) => {
    const name = o.value.toLowerCase()
    if (name.startsWith(q)) return 0
    const hay = `${name} ${o.title} ${o.description ?? ""}`.toLowerCase()
    if (hay.includes(q)) return 1
    // Letters in order, in the name and title only: a long description would match anything.
    let i = 0
    for (const ch of `${name} ${o.title}`.toLowerCase())
      if (ch === q[i] && ++i === q.length) return 2
    return undefined
  }
  return options
    .map((o, i) => ({ o, i, r: rank(o) }))
    .filter((x): x is { o: T; i: number; r: number } => x.r !== undefined)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o)
}

export function pick(
  ui: Ui,
  title: string,
  cmds: SubCommand[],
): Promise<SubCommand | undefined> {
  return ui
    .select<string>({
      title,
      options: cmds.map((c) => ({
        title: c.title,
        value: c.name,
        description: c.description,
        footer: c.usage,
        category: c.group,
      })),
      search: fuzzy,
    })
    .then((name) => cmds.find((c) => c.name === name))
}

/**
 * Runs what was typed after `/oob`: the fast path when it is complete, a
 * picker when it is not. Nothing runs unless every argument was given or chosen.
 */
export async function dispatch(
  ui: Ui,
  title: string,
  cmds: SubCommand[],
  input: string | undefined,
): Promise<void> {
  const p = parse(input, cmds)
  let b: Bound | undefined
  let ask: "all" | "required" = "required"
  if (p.kind === "command") b = p
  else {
    if (p.kind === "unknown")
      ui.toast(
        `No sub-command "${p.word}". Pick one, or run /oob help.`,
        "warning",
      )
    const list = p.kind === "ambiguous" ? p.matches : cmds
    const chosen = await pick(ui, title, list)
    if (!chosen) return
    const rest = p.kind === "ambiguous" ? p.rest : []
    b = bind(chosen, rest)
    if (rest.length === 0) ask = "all"
  }
  const why = b.cmd.unavailable?.()
  if (why) return ui.toast(why, "warning")
  if (b.extra.length > 0) return ui.toast(`Usage: ${b.cmd.usage}`, "warning")
  const values = await complete(ui, b, ask)
  if (values) await b.cmd.run(values)
}

/** The table behind `/oob help`, aligned for a dialog. */
export function helpText(cmds: SubCommand[]): string {
  const width = Math.max(...cmds.map((c) => c.usage.length))
  return [
    ...cmds.map((c) => `${c.usage.padEnd(width)}  ${c.description}`),
    "",
    `${PREFIX} alone opens a picker. Any prefix of a name works: ${PREFIX} ch o`,
  ].join("\n")
}

/** The table in the README. */
export function helpMarkdown(cmds: SubCommand[]): string {
  return [
    "| Command | What it does |",
    "| ------- | ------------ |",
    // A pipe inside a table cell has to be escaped, even in code.
    ...cmds.map(
      (c) => `| \`${c.usage.replaceAll("|", "\\|")}\` | ${c.description} |`,
    ),
  ].join("\n")
}
