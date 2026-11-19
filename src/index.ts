// Server entry. The bridge runs in the TUI (src/tui.ts): only the TUI context
// can answer a question form. OpenCode 2 loads a directory plugin through its
// index.js, so the server side exists and does nothing.
import type { Plugin } from "@opencode/plugin"

const plugin: Plugin.Plugin = {
  id: "oob-bridge",
  setup() {},
}

export default plugin
