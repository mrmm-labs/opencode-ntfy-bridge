/**
 * TUI entry: wires OpenCode 2 TUI events and the form reply API to the bridge,
 * and adds the `/oob` command and settings menu. Without a config file it
 * returns before touching the network.
 */
import type { Plugin } from "@opencode/plugin/tui"
import { join } from "node:path"

import { Bridge, type BridgeEvent, type Host } from "./bridge.ts"
import { connectorTypes } from "./connectors/index.ts"
import type { Connector } from "./connectors/types.ts"
import { dataDir, loadConfig } from "./config.ts"
import { log } from "./logger.ts"
import { runCommand, saveSession, type App } from "./menu.ts"
import { resolveOtel, Telemetry } from "./otel.ts"
import { PendingStore } from "./pending.ts"
import { Router } from "./routing.ts"
import { SettingsStore } from "./settings.ts"

type Context = Plugin.Context

const EVENTS: BridgeEvent["type"][] = [
  "form.created",
  "form.replied",
  "form.cancelled",
  "permission.asked",
  "permission.replied",
  "session.inbox.enqueued",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.renamed",
  "session.model.selected",
  "session.agent.selected",
  "session.text.delta",
  "session.text.ended",
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
        model: info.model?.id,
        modelRef: info.model
          ? {
              providerID: info.model.providerID,
              id: info.model.id,
              variant: info.model.variant,
            }
          : undefined,
      }
    },
    root: (id) => ctx.data.session.root(id) || id,
    replyForm: (sessionID, formID, answer) =>
      ctx.data.session.form.reply({ sessionID, formID, answer }),
    // Queued behind a running turn, so a message sent while the agent works never interrupts a step.
    prompt: async (sessionID, text) => {
      await ctx.client.session.prompt({ sessionID, text, delivery: "queue" })
    },
    busy: (id) => ctx.data.session.status(id) === "running",
    createSession: async ({ directory, agent, model }) => {
      const info = await ctx.client.session.create({
        location: { directory },
        agent,
        model,
      })
      return { id: info.id }
    },
    switchModel: (sessionID, model) =>
      ctx.client.session.switchModel({ sessionID, model }),
    switchAgent: (sessionID, agent) =>
      ctx.client.session.switchAgent({ sessionID, agent }),
    interrupt: async (sessionID) =>
      (await ctx.client.session.interrupt({ sessionID })).interrupted,
    compact: async (sessionID) => {
      await ctx.client.session.compact({ sessionID })
    },
    rename: (sessionID, title) =>
      ctx.client.session.update({ sessionID, title }),
    agents: async () => {
      let list = ctx.data.location.agent.list()
      if (!list) {
        await ctx.data.location.agent.sync()
        list = ctx.data.location.agent.list()
      }
      return (list ?? [])
        .filter((a) => a.mode !== "subagent" && !a.hidden)
        .map((a) => a.name)
    },
    models: async () => {
      let list = ctx.data.location.model.list()
      if (!list) {
        await ctx.data.location.model.sync()
        list = ctx.data.location.model.list()
      }
      return (list ?? [])
        .filter(
          (m) =>
            m.enabled &&
            m.status !== "deprecated" &&
            (m.type === undefined || m.type === "chat"),
        )
        .map((m) => ({
          ref: `${m.providerID}/${m.modelID}`,
          name: m.name,
          variants: m.variants.map((v) => v.id),
        }))
    },
  }
}

export async function setup(
  ctx: Context,
): Promise<(() => Promise<void>) | undefined> {
  // Registered before any await: OpenCode 2.3.2 ignores keymap layers
  // registered after setup has yielded, so /oob never appeared.
  let app: App | undefined
  // A layer defaults to the "base" input mode, which is inactive while the
  // prompt has focus, so slash completion never saw the command.
  ctx.keymap.layer(() => ({
    mode: "global",
    bindings: ["oob-bridge.route"],
    commands: [
      {
        id: "oob-bridge.route",
        title: "oob: settings, routing and channels",
        palette: true,
        slash: { name: "oob", aliases: ["ntfy"], arguments: true },
        run: (input) => runCommand(ctx, app, input),
      },
    ],
  }))

  const cfg = await loadConfig()
  if (!cfg) return undefined
  if ("error" in cfg) {
    log("config_error", { message: cfg.error })
    return undefined
  }

  // Off unless an endpoint is configured, here or in the OTLP environment variables.
  const tel = new Telemetry(resolveOtel(cfg.otel))
  const dir = dataDir()
  const settings = new SettingsStore(join(dir, "settings.json"))
  await settings.load()
  const connectors: Connector[] = Object.entries(cfg.channels).map(
    ([name, c]) => {
      const connector = connectorTypes[c.type].create(
        {
          name,
          dir,
          tel,
          settings: {
            get: () => settings.channel(name),
            set: (patch) => settings.set(name, patch),
          },
        },
        c.options,
      )
      // A choice made in the TUI wins over the file.
      connector.enabled = settings.channel(name).enabled ?? c.enabled
      return connector
    },
  )

  const store = new PendingStore(join(dir, "pending.jsonl"))
  await store.load()
  const router = new Router(cfg)
  for (const [id, v] of Object.entries(settings.sessions()))
    router.set(id, v.on, v.channel)
  const bridge = new Bridge(
    cfg,
    host(ctx),
    connectors,
    store,
    router,
    Date.now,
    tel,
  )
  app = { router, bridge, settings }
  for (const [id, v] of Object.entries(settings.sessions()))
    if (v.chat) bridge.restoreChat(id)
  bridge.onChat((root) => saveSession(app!, root))

  const off = EVENTS.map((type) =>
    ctx.data.on(
      type,
      (event) => void bridge.onEvent(event as unknown as BridgeEvent),
    ),
  )

  bridge.start()
  log("started", {
    otel: tel.enabled(),
    channels: connectors.map((c) => c.id),
    rules: cfg.rules.length,
  })
  return async () => {
    for (const f of off) f()
    await bridge.stop()
    await settings.flush()
    await tel.dispose()
  }
}

const plugin: Plugin.Definition = { id: "oob-bridge.tui", setup }

export default plugin
