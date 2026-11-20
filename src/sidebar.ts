/**
 * The OOB block in the session sidebar: what it shows (a pure function of the
 * session's state), what a click does, and the claim of the sidebar slot. Drawing
 * is passed in as `view`, so this file needs no UI toolkit: `sidebar.tsx` draws.
 */
import type { Plugin } from "@opencode/plugin/tui"

import type { Delivery } from "./config.ts"
import { applyRouting, type App } from "./menu.ts"

type Context = Plugin.Context

export type Action = "route" | "chat" | "delivery"
export type Tone = "normal" | "muted" | "ok" | "warn"
export type Part = { text: string; action?: Action; tone: Tone }
export type Line = { id: "route" | "chat" | "prompts"; parts: Part[] }

export type SidebarState = {
  mode: "on" | "off" | "auto"
  channel: string
  chat: boolean
  /** Why `chat.deny` blocks chat, when it does. */
  blocked?: string
  /** Whether some enabled channel can carry a chat at all. */
  chatCapable: boolean
  delivery: Delivery
  /** The session's delivery differs from `chat.delivery`. */
  override: boolean
  open: number
}

export type Outcome = { ok: boolean; text: string }

export const TITLE = "OOB"

export function sidebarState(app: App, root: string): SidebarState {
  const b = app.bridge
  return {
    mode: app.router.mode(root),
    channel: b.channelOf(root),
    chat: b.chatEnabled(root),
    blocked: b.chatBlocked(root),
    chatCapable: b.canChat(root),
    delivery: b.delivery(root),
    override: b.deliveryOverride(root) !== undefined,
    open: b.openPrompts(root),
  }
}

const ON_OFF: Record<SidebarState["mode"], Tone> = {
  on: "ok",
  off: "muted",
  auto: "normal",
}

/** At most three lines: routing, chat and delivery, and open prompts when there are any. */
export function sidebarLines(s: SidebarState): Line[] {
  const lines: Line[] = [
    {
      id: "route",
      parts: [
        {
          text: `📡 ${s.mode === "off" ? "off" : `${s.channel} · ${s.mode}`}`,
          action: "route",
          tone: ON_OFF[s.mode],
        },
      ],
    },
  ]
  if (s.chatCapable) {
    const chat: Part = s.blocked
      ? { text: "💬 chat: denied", action: "chat", tone: "warn" }
      : {
          text: `💬 chat: ${s.chat ? "on" : "off"}`,
          action: "chat",
          tone: s.chat ? "ok" : "muted",
        }
    lines.push({
      id: "chat",
      parts: s.blocked
        ? [chat]
        : [
            chat,
            {
              text: ` · ${s.delivery}${s.override ? "*" : ""}`,
              action: "delivery",
              tone: s.delivery === "steer" ? "warn" : "normal",
            },
          ],
    })
  }
  if (s.open > 0)
    lines.push({
      id: "prompts",
      parts: [
        {
          text: `⏳ ${s.open} open prompt${s.open === 1 ? "" : "s"}`,
          tone: "warn",
        },
      ],
    })
  return lines
}

const NEXT_MODE = { auto: "on", on: "off", off: "auto" } as const

/** What a click on a line does. The result is shown as a toast. */
export async function activate(
  app: App,
  root: string,
  action: Action,
): Promise<Outcome> {
  const b = app.bridge
  if (action === "route") {
    const next = NEXT_MODE[app.router.mode(root)]
    applyRouting(app, root, next, app.router.channel(root))
    return {
      ok: true,
      text:
        next === "on"
          ? `Routing on via ${b.channelOf(root)}`
          : `Routing ${next}`,
    }
  }
  if (action === "chat") return b.setChat(root, !b.chatEnabled(root))
  const next: Delivery = b.delivery(root) === "queue" ? "steer" : "queue"
  // Back at the configured default, the session needs no override.
  b.setDelivery(root, next === b.defaultDelivery() ? undefined : next)
  return {
    ok: true,
    text:
      next === "steer"
        ? "Delivery: steer. Messages from a chat are injected into the running turn."
        : "Delivery: queue. Messages from a chat wait for the turn to end.",
  }
}

/** What a drawing function is given for one sidebar. */
export type SidebarView = (p: {
  /** Re-read on every change: the lines to draw. */
  lines: () => Line[]
  /** Calls `fn` on every change; returns the way to stop. */
  subscribe: (fn: () => void) => () => void
  activate: (a: Action) => void
  colors: () => Record<Tone, unknown>
}) => unknown

// V2 theme leaves are a colour or a { base, ... } state set.
const leaf = (v: unknown) =>
  v && typeof v === "object" && "base" in v ? (v as { base: unknown }).base : v

export function toneColors(ctx: Context): Record<Tone, unknown> {
  // `theme` is optional in the plugin typings, so it is read loosely.
  const t = (ctx as unknown as { theme?: Record<string, any> }).theme
  return {
    normal: leaf(t?.text?.base),
    muted: leaf(t?.text?.muted),
    ok: leaf(t?.text?.feedback?.success),
    warn: leaf(t?.text?.feedback?.warning),
  }
}

/**
 * Claims the end of the session sidebar. Safe to call before the bridge exists:
 * the block stays empty until `attach`.
 */
export function registerSidebar(
  ctx: Context,
  view: SidebarView,
): { attach(app: App): void; dispose(): void } {
  let app: App | undefined
  let off: (() => void) | undefined
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((fn) => fn())
  const rootOf = (id: string) => ctx.data.session.root(id) || id

  const release = ctx.ui.slot({
    append: "sidebar.content",
    render: (input) =>
      view({
        lines: () => {
          const root = rootOf(input.sessionID)
          return app && root ? sidebarLines(sidebarState(app, root)) : []
        },
        subscribe: (fn) => {
          listeners.add(fn)
          return () => void listeners.delete(fn)
        },
        activate: (action) => {
          const a = app
          if (!a) return
          void activate(a, rootOf(input.sessionID), action).then(
            (out) =>
              ctx.ui.toast.show({
                message: out.text,
                variant: out.ok ? "success" : "warning",
              }),
            () =>
              ctx.ui.toast.show({
                message: "That did not work: see the log.",
                variant: "error",
              }),
          )
        },
        colors: () => toneColors(ctx),
      }) as never,
  })

  return {
    attach(next) {
      off?.()
      app = next
      off = next.bridge.subscribe(emit)
      emit()
    },
    dispose() {
      off?.()
      listeners.clear()
      release()
    },
  }
}
