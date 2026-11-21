// Server entry: the bridge runs here, once per OpenCode server, and sees every
// session. The TUI (src/tui.ts) only pilots it. OpenCode 2 loads a directory
// plugin through its index.js.
import type { Plugin } from "@opencode/plugin"

import { startServer } from "./server.ts"

const plugin: Plugin.Plugin = {
  id: "oob-bridge",
  setup: (ctx) => startServer(ctx),
}

export default plugin
