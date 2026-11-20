// OpenCode 2 discovers a directory's TUI plugin by a root tui entry.
import { setup } from "./dist/tui.js"

export default {
  id: "oob-bridge.tui",
  // The sidebar block is drawn by sidebar.tsx, loaded on demand.
  setup: (ctx: Parameters<typeof setup>[0]) =>
    setup(ctx, async () => (await import("./sidebar.tsx")).sidebar),
}
