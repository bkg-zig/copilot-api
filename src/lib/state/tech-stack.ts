/** Deterministic tech-stack + token extraction (no model, no network). */

const STACK_MARKERS: Array<[string, string[]]> = [
  ["typescript", ["typescript", "tsconfig"]],
  ["javascript", ["javascript", "\\.js", "nodeconfig"]],
  ["bun", ["bun.lockb", "bunfig"]],
  ["node", ["package.json", "node_modules"]],
  ["react", ["react", "jsx", "tsx"]],
  ["vue", ["vue", "\\.vue"]],
  ["python", ["python", "pyproject", "requirements"]],
  ["rust", ["rust", "cargo.toml"]],
  ["go", ["go.mod", "golang"]],
  ["postgres", ["postgres", "supabase", "pgvector"]],
  ["pgvector", ["pgvector", "vector("]],
  ["docker", ["dockerfile", "docker-compose"]],
  ["hono", ["hono"]],
  ["sqlite", ["sqlite", "\\.db"]],
]

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "was",
  "are",
  "it",
  "this",
  "that",
  "from",
  "by",
  "as",
  "at",
  "be",
  "not",
  "but",
  "so",
  "if",
  "then",
  "than",
  "into",
  "also",
  "can",
  "should",
  "would",
])

const SECRET_PATTERNS = [
  /\b(?:sk|ghp|ghp|github_pat|xox[baprs]|[A-Za-z0-9]{40,})\b/g,
  /postgres(ql)?:\/\/[^\s"']+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /(password|passwd|secret|token)\s*[:=]\s*\S+/gi,
]

export function extractTechStack(text: string): string[] {
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const [name, markers] of STACK_MARKERS) {
    if (markers.some((marker) => lower.includes(marker.replace("\\.", ".")))) {
      found.push(name)
    }
  }
  return found
}

export function extractTokens(text: string, maxTokens = 20): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokens) {
    if (!seen.has(token)) {
      seen.add(token)
      out.push(token)
    }
    if (out.length >= maxTokens) {
      break
    }
  }
  return out
}

/** Replace paths, URLs and secrets with placeholders (cross-repo safe). */
export function anonymize(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "<redacted>")
  }
  out = out.replace(/\/[^\s"']+/g, "<path>")
  out = out.replace(/https?:\/\/[^\s"']+/gi, "<url>")
  return out
}

export function mergeTechStack(
  ...lists: Array<string[] | undefined>
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const item of list ?? []) {
      const clean = item.trim().toLowerCase()
      if (clean && !seen.has(clean)) {
        seen.add(clean)
        out.push(clean)
      }
    }
  }
  return out
}
