import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

import { buildCommands } from "./menu.ts"
import { helpMarkdown } from "./subcommands.ts"

describe("README", () => {
  it("lists the /oob sub-commands exactly as the registry does", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8",
    )
    // Only names, usage and descriptions are read: no host is needed to build the list.
    const table = helpMarkdown(buildCommands({} as never, {} as never))
    // The formatter pads the cells: compare the rows without the padding.
    const flat = (t: string) => t.replace(/ +/g, " ").replace(/-+/g, "-")
    for (const row of table.split("\n"))
      assert.ok(flat(readme).includes(flat(row)), `README lacks: ${row}`)
  })
})
