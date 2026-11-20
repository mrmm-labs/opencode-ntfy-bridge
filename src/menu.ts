/** The `/oob` command: routing for the session, channel settings, pairing, test push, status. */
import type { Plugin } from "@opencode/plugin/tui"

import type { Bridge } from "./bridge.ts"
import type { Delivery } from "./config.ts"
import type { Connector } from "./connectors/types.ts"
import { renderQr } from "./qr.ts"
import type { Router } from "./routing.ts"
import type { SettingsStore } from "./settings.ts"

type Context = Plugin.Context

export type App = {
  router: Router
  bridge: Bridge
  settings: SettingsStore
}

const USAGE =
  "Usage: /oob [on [<channel>|all]|off|auto|chat on|chat off|delivery queue|steer|default|status|test|pair <channel>]"

/** Connectors that can bind to a chat. */
const pairable = (app: App) =>
  app.bridge.connectors().filter((c) => c.capabilities.pairing && c.pair)

const find = (app: App, name: string) =>
  app.bridge.connectors().find((c) => c.id.toLowerCase() === name.toLowerCase())

const toast = (
  ctx: Context,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) => ctx.ui.toast.show({ message, variant })

function sessionRoot(ctx: Context): string | undefined {
  const route = ctx.ui.router.current()
  return route.type === "session"
    ? ctx.data.session.root(route.sessionID) || route.sessionID
    : undefined
}

export async function runCommand(
  ctx: Context,
  app: App | undefined,
  input?: string,
): Promise<void> {
  if (!app)
    return toast(
      ctx,
      "oob bridge is not configured or still starting",
      "warning",
    )
  app.router.touch()
  const arg = (input ?? "").trim().toLowerCase().replace(/\s+/g, " ")
  if (!arg) return menu(ctx, app)
  const [word, via, ...extra] = arg.split(" ")
  if (word === "on" && extra.length === 0)
    return setRouting(ctx, app, "on", via)
  if ((word === "off" || word === "auto") && via === undefined)
    return setRouting(ctx, app, word)
  if (word === "chat" && (via === "on" || via === "off") && extra.length === 0)
    return setChat(ctx, app, via === "on")
  if (
    word === "delivery" &&
    (via === "queue" || via === "steer" || via === "default") &&
    extra.length === 0
  )
    return setDelivery(ctx, app, via === "default" ? undefined : via)
  if (arg === "status") return status(ctx, app)
  if (arg === "test") return test(ctx, app)
  if (word === "pair" && extra.length === 0) {
    const c = via === undefined ? pairable(app)[0] : find(app, via)
    if (via === undefined && pairable(app).length > 1)
      return toast(
        ctx,
        `Pair which? ${pairable(app)
          .map((x) => x.id)
          .join(", ")}`,
        "warning",
      )
    // From the command line the dialog is not awaited: the command returns at once.
    return void (await pair(ctx, app, c))
  }
  toast(ctx, USAGE, "warning")
}

function setRouting(
  ctx: Context,
  app: App,
  mode: "on" | "off" | "auto",
  channel?: string,
) {
  const root = sessionRoot(ctx)
  if (!root) return toast(ctx, "Open a session first", "warning")
  const ids = app.bridge.connectors().map((c) => c.id)
  if (channel !== undefined && channel !== "all") {
    const c = find(app, channel)
    if (!c)
      return toast(
        ctx,
        `No channel "${channel}" (use ${["all", ...ids].join(", ")})`,
        "warning",
      )
    channel = c.id
  }
  applyRouting(app, root, mode, channel)
  toast(ctx, `oob routing: ${describe(app, root)}`)
}

/** Sets the routing of a session and keeps it. */
export function applyRouting(
  app: App,
  root: string,
  mode: "on" | "off" | "auto",
  channel?: string,
): void {
  app.router.set(root, mode === "auto" ? undefined : mode === "on", channel)
  saveSession(app, root)
}

/** Keeps a session's routing and chat choices across restarts. */
export function saveSession(app: App, root: string): void {
  const mode = app.router.mode(root)
  const chat = app.bridge.chatEnabled(root)
  const delivery = app.bridge.deliveryOverride(root)
  app.settings.setSession(
    root,
    mode === "auto" && !chat && !delivery
      ? undefined
      : {
          on: mode === "auto" ? undefined : mode === "on",
          channel: app.router.channel(root),
          chat: chat || undefined,
          delivery,
        },
  )
  app.bridge.notify()
}

function setDelivery(ctx: Context, app: App, d: Delivery | undefined) {
  const root = sessionRoot(ctx)
  if (!root) return toast(ctx, "Open a session first", "warning")
  app.bridge.setDelivery(root, d)
  toast(ctx, `Delivery for this session: ${app.bridge.delivery(root)}`)
}

async function setChat(ctx: Context, app: App, on: boolean): Promise<void> {
  const root = sessionRoot(ctx)
  if (!root) return toast(ctx, "Open a session first", "warning")
  const out = await app.bridge.setChat(root, on)
  toast(ctx, out.text, out.ok ? "success" : "warning")
}

const describe = (app: App, root: string) => {
  const via = app.router.channel(root)
  const base =
    app.router.mode(root) === "on" && via
      ? `on via ${via}`
      : app.router.mode(root)
  return app.bridge.chatEnabled(root) ? `${base}, chat on` : base
}

const BACK = { title: "← Back", value: "back", description: undefined }

/** Stays open after each action; Esc closes it, "← Back" in a submenu returns here. */
async function menu(ctx: Context, app: App): Promise<void> {
  for (;;) {
    const choice = await mainMenu(ctx, app)
    if (!choice) return
    if (choice === "routing") await routing(ctx, app)
    else if (choice === "channels") await channelList(ctx, app)
    else if (choice.startsWith("pair:")) {
      const closed = await pair(ctx, app, find(app, choice.slice(5)))
      if (closed) await closed
    } else if (choice === "test") await test(ctx, app)
    else if (choice === "status") await status(ctx, app)
  }
}

function mainMenu(ctx: Context, app: App): Promise<string | undefined> {
  const root = sessionRoot(ctx)
  const channels = app.bridge.status().channels
  return ctx.ui.dialog.select({
    title: "OOB bridge",
    options: [
      {
        title: "This session",
        description: root ? `now: ${describe(app, root)}` : "open a session",
        value: "routing",
      },
      {
        title: "Channels",
        description: channels
          .map((c) => `${c.id} ${c.enabled ? "on" : "off"}`)
          .join(", "),
        value: "channels",
      },
      ...pairable(app).map((c) => ({
        title: `Pair ${c.id}`,
        value: `pair:${c.id}`,
        description: undefined,
      })),
      { title: "Send test push", value: "test", description: undefined },
      { title: "Status", value: "status", description: undefined },
    ],
  })
}

async function routing(ctx: Context, app: App): Promise<void> {
  const root = sessionRoot(ctx)
  if (!root) return toast(ctx, "Open a session first", "warning")
  const ids = app.bridge.status().channels.map((c) => c.id)
  const via = app.router.channel(root)
  const mode = app.router.mode(root)
  const chat = app.bridge.chatEnabled(root)
  const pick = await ctx.ui.dialog.select<string>({
    title: "This session",
    current: mode === "on" && via ? `on:${via}` : mode,
    options: [
      { title: "on", value: "on", description: "mirror now, default channel" },
      ...[...ids, ...(ids.length > 1 ? ["all"] : [])].map((id) => ({
        title: `on via ${id}`,
        value: `on:${id}`,
        description: `mirror now, only ${id === "all" ? "through every channel" : id}`,
      })),
      { title: "off", value: "off", description: "never mirror" },
      { title: "auto", value: "auto", description: "when away, by the rules" },
      {
        title: `Chat from Telegram: ${chat ? "on" : "off"}`,
        value: "chat",
        description: chat
          ? "stop taking messages from the topic"
          : "let messages in this session's topic reach it",
      },
      BACK,
    ],
  })
  if (!pick || pick === "back") return
  if (pick === "chat") return setChat(ctx, app, !chat)
  const [m, ch] = pick.split(":")
  setRouting(ctx, app, m as "on" | "off" | "auto", ch)
}

/** Stays open so several channels can be switched in a row. */
async function channelList(ctx: Context, app: App): Promise<void> {
  for (;;) {
    const channels = app.bridge.status().channels
    const id = await ctx.ui.dialog.select<string>({
      title: "Channels (pick one to switch it)",
      options: [
        ...channels.map((c) => ({
          title: `${c.id}: ${c.enabled ? "on" : "off"}`,
          value: c.id,
          description: undefined,
        })),
        BACK,
      ],
    })
    const c = channels.find((x) => x.id === id)
    if (!c) return
    app.bridge.setEnabled(c.id, !c.enabled)
    app.settings.set(c.id, { enabled: !c.enabled })
    toast(ctx, `${c.id}: ${c.enabled ? "off" : "on"}`)
  }
}

async function test(ctx: Context, app: App): Promise<void> {
  const results = await app.bridge.test()
  if (results.length === 0)
    return toast(ctx, "No channel is enabled", "warning")
  toast(
    ctx,
    `Test push: ${results.map((r) => `${r.id} ${r.ok ? "sent" : "failed"}`).join(", ")}`,
    results.every((r) => r.ok) ? "success" : "error",
  )
}

async function status(ctx: Context, app: App): Promise<void> {
  const st = app.bridge.status()
  const root = sessionRoot(ctx)
  const lines = st.channels.map((c) => {
    const state = !c.enabled
      ? "off"
      : c.connected === undefined
        ? "on"
        : c.connected
          ? "on, connected"
          : "on, not connected"
    return [
      `${c.id}: ${state}${c.lastError ? ` (last error: ${c.lastError})` : ""}`,
      ...(c.warning ? [`  ⚠ ${c.warning}`] : []),
    ].join("\n")
  })
  lines.push(`Open prompts: ${st.pending}`)
  if (root) lines.push(`This session: ${describe(app, root)}`)
  await ctx.ui.dialog.alert({
    title: "OOB bridge status",
    message: lines.join("\n"),
  })
}

/** Resolves to a promise that settles when the pairing dialog closes. */
async function pair(
  ctx: Context,
  app: App,
  c: Connector | undefined,
): Promise<Promise<void> | undefined> {
  if (!c?.capabilities.pairing || !c.pair)
    return void toast(
      ctx,
      c
        ? `${c.id} has no pairing`
        : "No channel can be paired: add one that supports it to the config file",
      "warning",
    )
  if (!c.enabled) {
    app.bridge.setEnabled(c.id, true)
    app.settings.set(c.id, { enabled: true })
  }
  const p = await app.bridge.pair(c)
  if (!p)
    return void toast(ctx, `${c.id}: pairing failed, see the log`, "error")
  const lines = [`Pair ${c.id} with OpenCode.`]
  if (p.hint) lines.push(p.hint)
  if (p.link) {
    const qr = renderQr(p.link)
    const w = terminal(ctx)
    // Dialog padding, title and the lines below the code.
    if (!w || (w.cols >= qr.width + 10 && w.rows >= qr.height + 14))
      lines.push("", "Scan with your phone camera:", ...qr.lines)
    lines.push("", "Or open this link:", p.link)
  }
  for (const l of p.links ?? []) lines.push("", `${l.label}:`, l.url)
  const minutes = Math.max(1, Math.round((p.expiresAt - Date.now()) / 60_000))
  lines.push(
    "",
    `Or send this code: ${p.code}`,
    `It works once and expires in ${minutes} minutes.`,
  )
  let open = true
  const closed = ctx.ui.dialog
    .alert({ title: `Pair ${c.id}`, message: lines.join("\n") })
    .then(() => {
      open = false
    })
  void p.done.then((ok) => {
    if (open) ctx.ui.dialog.clear()
    if (ok) toast(ctx, `${c.id} paired`, "success")
    else toast(ctx, "Pairing code expired", "warning")
  })
  return closed
}

/** Terminal size when the renderer reports it. */
function terminal(ctx: Context): { cols: number; rows: number } | undefined {
  const r = (ctx.renderer ?? {}) as unknown as Record<string, unknown>
  const cols = Number(r.width ?? r.terminalWidth ?? process.stdout.columns)
  const rows = Number(r.height ?? r.terminalHeight ?? process.stdout.rows)
  return cols > 0 && rows > 0 ? { cols, rows } : undefined
}
