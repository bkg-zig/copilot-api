/**
 * Secret redaction for logs and diagnostics, ported from the zerokey proxy.
 *
 * Keys are classified by meaning, not by an exact-name list: the normalized
 * key (lowercase, separators stripped) is matched against secret roots, so
 * aliases and long forms such as `githubCopilotCredentialValue` or
 * `client-passphrase` are still treated as secrets. Unknown shapes fail
 * closed in `redactValue` (circular/hostile values become `<unredactable>`).
 */

const REDACTED = "<redacted>"

// Normalized (lowercase alphanumerics only) secret roots. `author` is excluded
// explicitly below: it contains "auth" but names a person, not a credential.
const SECRET_ROOTS =
  /(token|secret|passwd|password|passphrase|passcode|credential|apikey|cookie|privatekey|authorization|bearer|accesskey|sessionkey|authkey)/

export function isSecretKey(name: unknown): boolean {
  if (typeof name !== "string") return false
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  if (
    normalized === ""
    || normalized === "author"
    || normalized === "authors"
  ) {
    return false
  }
  return SECRET_ROOTS.test(normalized)
}

const KEY_ALTERNATION =
  "access[_-]?token|refresh[_-]?token|api[_-]?key|id[_-]?token|client[_-]?secret|access|refresh|secret|password|passwd|passphrase|token|credential|private[_-]?key|authorization|cookie|bearer"

const TEXT_REDACTIONS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}={0,2}/gi, `$1${REDACTED}`],
  [/(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi, `$1${REDACTED}`],
  [
    new RegExp(
      `(["']?(?:${KEY_ALTERNATION})["']?\\s*[:=]\\s*["'])([^"']*)(["'])`,
      "gi",
    ),
    `$1${REDACTED}$3`,
  ],
  [
    new RegExp(`(\\b(?:${KEY_ALTERNATION})\\s*[:=]\\s*)([^\\s&;,"']+)`, "gi"),
    `$1${REDACTED}`,
  ],
  [/\b(sk-)[A-Za-z0-9._-]{8,}/g, `$1${REDACTED}`],
  [/\b(eyJ)[A-Za-z0-9._-]{20,}/g, `$1${REDACTED}`],
  [/\b(gh[posur]_)[A-Za-z0-9_]{20,}/g, `$1${REDACTED}`],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, `$1${REDACTED}`],
  [/(data:[^;,\s]+;base64,)[A-Za-z0-9+/_=-]+/gi, `$1${REDACTED}`],
  [/([?&](?:se|sig|sp|spr|srt|ss|st|sv)=)[^&#\s]*/gi, `$1${REDACTED}`],
]

export function redactText(value: string): string {
  let out = value
  for (const [pattern, replacement] of TEXT_REDACTIONS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export function redactValue<T>(value: T): T {
  try {
    return redactValueInner(value, new Set()) as T
  } catch {
    const fallback: unknown = "<unredactable>"
    return fallback as T
  }
}

function redactValueInner(value: unknown, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return redactText(value)
  if (typeof value !== "object") return value
  if (seen.has(value)) return "<unredactable>"
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactValueInner(item, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      isSecretKey(key) && item !== null && item !== undefined ?
        REDACTED
      : redactValueInner(item, seen)
  }
  return out
}

const MAX_STRING_CHARS = 2000
const MAX_ARRAY_ITEMS = 100
const MAX_OBJECT_KEYS = 100
const MAX_DEPTH = 8

function sanitizeForDiagnosticsValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "<truncated>"
  if (value === null || value === undefined) return value
  if (typeof value === "string") {
    const redacted = redactText(value)
    return redacted.length > MAX_STRING_CHARS ?
        `${redacted.slice(0, MAX_STRING_CHARS)}…<truncated>`
      : redacted
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeForDiagnosticsValue(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) out.push("<more entries truncated>")
    return out
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS)
    const out: Record<string, unknown> = {}
    for (const [key, item] of entries) {
      out[key] =
        isSecretKey(key) && item !== null && item !== undefined ?
          REDACTED
        : sanitizeForDiagnosticsValue(item, depth + 1)
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) out._truncated = true
    return out
  }
  // Functions and symbols have no safe diagnostic representation.
  return `<${typeof value}>`
}

/** Bounded, redacted projection safe to return from a diagnostics endpoint. */
export function sanitizeForDiagnostics<T>(value: T, depth = 0): T {
  return sanitizeForDiagnosticsValue(value, depth) as T
}
