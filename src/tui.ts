/**
 * TUI entry: wires OpenCode 2 TUI events and the form reply API to the bridge,
 * and adds the `/ntfy on|off|auto` command. Without a config file it returns
 * before touching the network.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { join } from "node:path"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { dataDir, loadConfig } from "./config.ts"
import { log } from "./logger.ts"
import { Ntfy } from "./ntfy.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { resolveToken } from "./token.ts"

type Context = Plugin.Context

const EVENTS: BridgeEvent["type"][] = [
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
  "session.inbox.enqueued",
  "session.execution.succeeded",
  "session.execution.failed",
]

export function host(ctx: Context): Host {
  return {
    async session(id) {
      let info = ctx.data.session.get(id)
      if (!info) {
        try {
          info = await ctx.client.session.get({ sessionID: id })
        } catch {
          return undefined
        }
      }
      return {
        id: info.id,
        parentID: info.parentID,
        agent: info.agent,
        directory: info.location?.directory,
        title: info.title,
      }
    },
    root: (id) => ctx.data.session.root(id) || id,
    replyForm: (sessionID, formID, answer) =>
      ctx.data.session.form.reply({ sessionID, formID, answer }),
  }
}

export async function setup(
  ctx: Context,
): Promise<(() => Promise<void>) | undefined> {
  // Registered before any await: OpenCode 2.3.2 ignores keymap layers
  // registered after setup has yielded, so /ntfy never appeared.
  let router: Router | undefined
  // A layer defaults to the "base" input mode, which is inactive while the
  // prompt has focus, so slash completion never saw /ntfy.
  ctx.keymap.layer(() => ({
    mode: "global",
    bindings: ["ntfy-bridge.route"],
    commands: [
      {
        id: "ntfy-bridge.route",
        title: "ntfy: route this session (on, off, auto)",
        slash: { name: "ntfy", arguments: true },
        run: (input) => {
          if (!router)
            return ctx.ui.toast.show({
              message: "ntfy bridge is not configured or still starting",
              variant: "warning",
            })
          router.touch()
          const route = ctx.ui.router.current()
          if (route.type !== "session")
            return ctx.ui.toast.show({
              message: "Open a session first",
              variant: "warning",
            })
          const root = ctx.data.session.root(route.sessionID) || route.sessionID
          const arg = (input ?? "").trim().toLowerCase()
          if (arg === "on" || arg === "off" || arg === "auto")
            router.set(root, arg === "auto" ? undefined : arg === "on")
          else if (arg)
            return ctx.ui.toast.show({
              message: "Usage: /ntfy on|off|auto",
              variant: "warning",
            })
          ctx.ui.toast.show({
            message: `ntfy routing: ${router.mode(root)}`,
            variant: "info",
          })
        },
      },
    ],
  }))

  const cfg = await loadConfig()
  if (!cfg) return undefined
  if ("error" in cfg) {
    log("config_error", { message: cfg.error })
    return undefined
  }

  let token: Promise<string | undefined> | undefined
  const ntfy = new Ntfy({
    server: cfg.server,
    topics: cfg.topics,
    actionAuth: cfg.actionAuth,
    // Resolved once; a failed command is retried on the next request.
    token: () =>
      (token ??= resolveToken(cfg.token).catch((err) => {
        token = undefined
        throw err
      })),
  })
  const store = new PendingStore(join(dataDir(), "pending.jsonl"))
  await store.load()
  router = new Router(cfg)
  const bridge = new Bridge(cfg, host(ctx), ntfy, store, router)

  const off = EVENTS.map((type) =>
    ctx.data.on(
      type,
      (event) => void bridge.onEvent(event as unknown as BridgeEvent),
    ),
  )

  bridge.start()
  log("started", { server: cfg.server, rules: cfg.rules.length })
  return async () => {
    for (const f of off) f()
    await bridge.stop()
  }
}

const plugin: Plugin.Definition = { id: "ntfy-bridge.tui", setup }

export default plugin
