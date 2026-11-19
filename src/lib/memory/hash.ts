import { createHash } from "node:crypto"

/**
 * Collapse whitespace so the same sentence written with different spacing or
 * newlines maps to the same content hash.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Stable, content-addressed id for an entry. Two entries with the same
 * normalized text share a hash, which is how duplicates are collapsed.
 */
export function contentHash(text: string): string {
  return createHash("sha256")
    .update(normalizeText(text))
    .digest("hex")
    .slice(0, 32)
}

/** One-line, length-bounded form used for steps and tool results. */
export function compactText(text: string, limit = 240): string {
  const normalized = normalizeText(text).replace(/\n+/g, " ")
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}
