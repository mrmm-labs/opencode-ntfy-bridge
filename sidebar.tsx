/** @jsxImportSource @opentui/solid */
/**
 * Draws the OOB block of the session sidebar. What it shows and what a click
 * does is decided in src/sidebar.ts; this file only turns that into elements.
 * It is loaded by the TUI host as source, like tui.tsx.
 */
import { createMemo, createSignal, For, onCleanup } from "solid-js"

import type { Line, SidebarView, Tone } from "./src/sidebar.ts"

function Block(p: Parameters<SidebarView>[0]) {
  const [tick, setTick] = createSignal(0)
  onCleanup(p.subscribe(() => setTick((n) => n + 1)))
  const lines = createMemo<Line[]>(() => {
    tick()
    return p.lines()
  })
  const color = (tone: Tone) => p.colors()[tone] as string | undefined
  return (
    <box flexDirection="column" flexShrink={0}>
      {lines().length > 0 && (
        <text fg={color("muted")} wrapMode="none" truncate>
          OOB
        </text>
      )}
      <For each={lines()}>
        {(line) => (
          <box flexDirection="row">
            <For each={line.parts}>
              {(part) => (
                <text
                  fg={color(part.tone)}
                  wrapMode="none"
                  truncate
                  onMouseUp={() => part.action && p.activate(part.action)}
                >
                  {part.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

export const sidebar: SidebarView = (p) => <Block {...p} />
