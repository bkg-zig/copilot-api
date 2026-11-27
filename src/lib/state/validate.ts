const MAX_STRING = 4000
const MAX_ARRAY = 200
const MAX_ITEM = 1000
const MAX_EVENT_SUMMARY = 4000

/** Bounded, deduplicated string list. */
export function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value.slice(0, MAX_ARRAY)) {
    if (typeof item !== "string") {
      continue
    }
    const clean = item.trim().slice(0, MAX_ITEM)
    if (!clean || seen.has(clean)) {
      continue
    }
    seen.add(clean)
    out.push(clean)
  }
  return out
}

export function cleanString(value: unknown, max = MAX_STRING): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

export function clampLimit(
  value: unknown,
  fallback: number,
  max = 100,
): number {
  const parsed =
    typeof value === "string" || typeof value === "number" ?
      Number.parseInt(String(value), 10)
    : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(parsed, max)
}

export const MAX_EVENT_SUMMARY_LENGTH = MAX_EVENT_SUMMARY
