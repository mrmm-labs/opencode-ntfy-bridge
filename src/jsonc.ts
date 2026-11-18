/** Parses JSON with `//` and block comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    } else if (c === "}" || c === "]") {
      out = out.replace(/,\s*$/, "") + c
    } else {
      out += c
    }
    i++
  }
  return JSON.parse(out)
}
