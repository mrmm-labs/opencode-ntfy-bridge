/** Secret filter and redaction, applied to every body that leaves the machine. */

export type Redact =
  | { mode: "full" }
  | { mode: "head"; n: number }
  | { mode: "title" }

const MASK = "[redacted]"

// Values the plugin itself holds (the ntfy token), masked wherever they appear.
const known = new Set<string>()

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) known.add(value)
}

const PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    MASK,
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\btk_[A-Za-z0-9]{20,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [
    /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    `$1${MASK}`,
  ],
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
]

/** Masks known secret shapes and every registered secret. */
export function filterSecrets(text: string): string {
  let out = text
  for (const value of known) out = out.split(value).join(MASK)
  for (const [re, to] of PATTERNS) out = out.replace(re, to)
  return out
}

/** Filters secrets, then applies the configured redaction. */
export function redact(text: string, mode: Redact): string {
  const clean = filterSecrets(text)
  if (mode.mode === "title") return "(details hidden, open OpenCode)"
  if (mode.mode === "head" && clean.length > mode.n)
    return `${clean.slice(0, mode.n)}…`
  return clean
}

export function parseRedact(value: unknown): Redact | undefined {
  if (value === undefined || value === "full") return { mode: "full" }
  if (value === "title") return { mode: "title" }
  const m = typeof value === "string" ? /^head:(\d+)$/.exec(value) : null
  if (m && Number(m[1]) > 0) return { mode: "head", n: Number(m[1]) }
  return undefined
}
