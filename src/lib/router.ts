import type {
  RouterConfig,
  RouterModelHint,
  RouterStrategy,
} from "~/lib/types/config"

export const DEFAULT_ROUTER_ALIAS = "auto"

const MAX_TEXT_CHARS = 20_000
const MAX_DEPTH = 10
const LARGE_PROMPT_CHARS = 4_000
const SIMPLE_PROMPT_CHARS = 400

const TEXT_KEYS = new Set([
  "content",
  "input",
  "input_text",
  "instruction",
  "output_text",
  "prompt",
  "query",
  "system",
  "text",
])

const IMAGE_KEYS = new Set([
  "image",
  "image_base64",
  "image_url",
  "input_image",
  "source",
])

const wordPattern = (words: Array<string>): RegExp =>
  new RegExp(`\\b(?:${words.join("|")})\\b`, "i")

const CODE_PATTERN = wordPattern([
  "algorithm",
  "api",
  "bug",
  "class",
  "code",
  "compile",
  "debug",
  "deepseek",
  "endpoint",
  "error",
  "exception",
  "function",
  "golang",
  "java",
  "javascript",
  "method",
  "python",
  "refactor",
  "regex",
  "repository",
  "rust",
  "sql",
  "stack ?trace",
  "test case",
  "typescript",
  "unit test",
])
const REASONING_PATTERN = wordPattern([
  "analyse",
  "analyze",
  "architecture",
  "compare",
  "complex",
  "deep dive",
  "design",
  "evaluate",
  "optimise",
  "optimize",
  "plan",
  "proof",
  "prove",
  "reason",
  "research",
  "step by step",
  "strategy",
  "trade-?off",
])
const SIMPLE_PATTERN = wordPattern([
  "define",
  "hello",
  "hey",
  "hi",
  "list",
  "name",
  "rewrite",
  "summarise",
  "summarize",
  "thanks",
  "thank you",
  "translate",
  "what is",
  "who is",
])
const SAFETY_PATTERN = wordPattern([
  "abuse",
  "classify",
  "content filter",
  "harmful",
  "moderation",
  "policy",
  "safety",
  "toxic",
])
const VISION_PATTERN = wordPattern([
  "chart",
  "diagram",
  "draw",
  "figure",
  "image",
  "ocr",
  "photo",
  "picture",
  "render",
  "screenshot",
  "vision",
])

const PARAM_PATTERN = /(\d+(?:\.\d+)?)\s*b\b/i
const PREMIUM_PATTERN = /ultra|super|opus|max|large|pro\b|550b|120b/
const ECONOMY_PATTERN =
  /flash|mini|lightning|nano|tiny|small|\bxs\b|a3b|a4b|a55b/
const MODEL_VISION_PATTERN = /\b(?:vl|vision|multimodal|image)\b|diffusion/
const MODEL_CODE_PATTERN = /code|coder|deepseek|qwen|nemotron|gpt/
const MODEL_REASONING_PATTERN = /reason|think|ultra|super|nemotron|deepseek|gpt/
const MODEL_SAFETY_PATTERN = /safety|guard|moderation|content/

interface ModelTraits {
  power: number
  cost: number
  vision: boolean
  code: boolean
  reasoning: boolean
  safety: boolean
}

interface Candidate {
  model: string
  traits: ModelTraits
}

interface Rule {
  pattern: RegExp
  model: string
}

interface PreparedRouter {
  enabled: boolean
  alias: string
  strategy: RouterStrategy
  defaultModel: string | null
  fallbackModel: string | null
  rules: Array<Rule>
  candidates: Array<Candidate>
}

const EMPTY_INTENT: PromptIntent = Object.freeze({
  text: "",
  hasImages: false,
  chars: 0,
  code: false,
  reasoning: false,
  simple: false,
  safety: false,
  vision: false,
})

const IMAGE_ONLY_INTENT: PromptIntent = Object.freeze({
  ...EMPTY_INTENT,
  hasImages: true,
  vision: true,
})

// Config objects are immutable snapshots; reloads replace them, so the cache
// key keeps compiled regexes and normalized traits tied to the right version.
const preparedCache = new WeakMap<RouterConfig, PreparedRouter>()

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function inferTraits(model: string, hint?: RouterModelHint): ModelTraits {
  const lower = model.toLowerCase()
  const parameters = PARAM_PATTERN.exec(lower)
  const billions = parameters ? Number.parseFloat(parameters[1]) : Number.NaN

  let power =
    !Number.isFinite(billions) ? 50
    : billions >= 300 ? 95
    : billions >= 100 ? 82
    : billions >= 50 ? 70
    : billions >= 25 ? 55
    : billions >= 12 ? 45
    : 32
  let cost = power

  if (PREMIUM_PATTERN.test(lower)) {
    power += 8
    cost += 10
  }
  if (ECONOMY_PATTERN.test(lower)) {
    power -= 12
    cost -= 20
  }

  return {
    power: clamp(hint?.power ?? power, 0, 100),
    cost: clamp(hint?.cost ?? cost, 0, 100),
    vision: hint?.vision ?? MODEL_VISION_PATTERN.test(lower),
    code: hint?.code ?? MODEL_CODE_PATTERN.test(lower),
    reasoning: hint?.reasoning ?? MODEL_REASONING_PATTERN.test(lower),
    safety: hint?.safety ?? MODEL_SAFETY_PATTERN.test(lower),
  }
}

function compileRule(
  match: string,
  model: string,
  flags: string | undefined,
): Rule | null {
  try {
    // Only the first match matters; global/sticky flags would make repeated
    // tests stateful and are therefore dropped.
    return {
      pattern: new RegExp(match, (flags ?? "i").replaceAll(/[gy]/g, "")),
      model,
    }
  } catch {
    return null
  }
}

function compileRouter(config: RouterConfig): PreparedRouter {
  const rules: Array<Rule> = []
  for (const rule of config.rules ?? []) {
    if (typeof rule?.match !== "string" || typeof rule.model !== "string") {
      continue
    }
    const compiled = compileRule(rule.match, rule.model, rule.flags)
    if (compiled) rules.push(compiled)
  }

  const seen = new Set<string>()
  const candidates: Array<Candidate> = []
  for (const entry of config.pool ?? []) {
    if (typeof entry !== "string") continue
    const model = entry.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    candidates.push({
      model,
      traits: inferTraits(model, config.modelHints?.[model]),
    })
  }

  const defaultModel = config.defaultModel?.trim() || null
  return {
    enabled: config.enabled === true,
    alias: config.alias?.trim() || DEFAULT_ROUTER_ALIAS,
    strategy: config.strategy ?? "auto",
    defaultModel,
    fallbackModel: defaultModel ?? candidates[0]?.model ?? null,
    rules,
    candidates,
  }
}

function prepareRouter(config: RouterConfig): PreparedRouter {
  let prepared = preparedCache.get(config)
  if (!prepared) {
    prepared = compileRouter(config)
    preparedCache.set(config, prepared)
  }
  return prepared
}

export function getRouterAlias(config: RouterConfig): string {
  return config.alias?.trim() || DEFAULT_ROUTER_ALIAS
}

export interface PromptIntent {
  text: string
  hasImages: boolean
  chars: number
  code: boolean
  reasoning: boolean
  simple: boolean
  safety: boolean
  vision: boolean
}

interface PromptScan {
  parts: Array<string>
  chars: number
  hasImages: boolean
}

function appendText(scan: PromptScan, value: string): void {
  const separator = scan.parts.length > 0 ? 1 : 0
  const room = MAX_TEXT_CHARS - scan.chars - separator
  if (room <= 0) return
  const piece = value.length <= room ? value : value.slice(0, room)
  if (separator) {
    scan.parts.push("\n")
    scan.chars += 1
  }
  scan.parts.push(piece)
  scan.chars += piece.length
}

function isImageValue(key: string, value: unknown): boolean {
  if (key !== "source" || !value || typeof value !== "object") {
    return Boolean(value)
  }
  const source = value as Record<string, unknown>
  return (
    source.type === "base64" || source.type === "url" || Boolean(source.data)
  )
}

/** One traversal collects text and image signals for every supported payload. */
function scanPrompt(value: unknown, scan: PromptScan, depth: number): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return
  if (typeof value === "string") {
    appendText(scan, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) scanPrompt(item, scan, depth + 1)
    return
  }
  if (typeof value !== "object") return

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (IMAGE_KEYS.has(key)) {
      if (isImageValue(key, child)) scan.hasImages = true
      continue
    }
    if (child === null || typeof child !== "object") {
      if (TEXT_KEYS.has(key) && typeof child === "string") {
        appendText(scan, child)
      }
      continue
    }
    scanPrompt(child, scan, depth + 1)
  }
}

export function analyzePrompt(body: unknown): {
  text: string
  hasImages: boolean
} {
  if (typeof body === "string") return { text: body, hasImages: false }
  const scan: PromptScan = { parts: [], chars: 0, hasImages: false }
  scanPrompt(body, scan, 0)
  const text =
    scan.parts.length === 0 ? ""
    : scan.parts.length === 1 ? scan.parts[0]
    : scan.parts.join("")
  return { text, hasImages: scan.hasImages }
}

export function extractPromptText(body: unknown): string {
  return analyzePrompt(body).text
}

export function bodyHasImage(body: unknown): boolean {
  return analyzePrompt(body).hasImages
}

export function classifyPrompt(text: string, hasImages: boolean): PromptIntent {
  if (!text) return hasImages ? IMAGE_ONLY_INTENT : EMPTY_INTENT
  const chars = text.length
  const code = CODE_PATTERN.test(text)
  const safety = SAFETY_PATTERN.test(text)
  const vision = hasImages || VISION_PATTERN.test(text)
  const reasoning = chars >= LARGE_PROMPT_CHARS || REASONING_PATTERN.test(text)
  const simple =
    !hasImages
    && !code
    && !reasoning
    && !safety
    && chars < SIMPLE_PROMPT_CHARS
    && SIMPLE_PATTERN.test(text)
  return { text, hasImages, chars, code, reasoning, simple, safety, vision }
}

function scoreCandidate(
  traits: ModelTraits,
  intent: PromptIntent,
): number | null {
  if (intent.vision && !traits.vision) return null
  if (intent.safety && !traits.safety) return null

  let score =
    intent.simple ? traits.power * 0.25 - traits.cost * 0.75 : traits.power
  if (intent.code) score += traits.code ? 25 : -20
  if (intent.reasoning) score += traits.reasoning ? 25 : -10
  if (intent.chars >= LARGE_PROMPT_CHARS) score += traits.power * 0.15
  if (intent.safety) score += 30
  return score
}

function chooseModel(
  router: PreparedRouter,
  intent: PromptIntent,
): string | null {
  if (
    (router.strategy === "auto" || router.strategy === "rules")
    && router.rules.length > 0
  ) {
    for (const rule of router.rules) {
      if (rule.pattern.test(intent.text)) return rule.model
    }
  }
  if (router.strategy === "rules") {
    return router.defaultModel ?? router.fallbackModel
  }

  let best: string | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of router.candidates) {
    const score = scoreCandidate(candidate.traits, intent)
    if (score !== null && score > bestScore) {
      bestScore = score
      best = candidate.model
    }
  }
  return best ?? router.defaultModel ?? router.fallbackModel
}

export function selectRoutedModel(
  intent: PromptIntent,
  config: RouterConfig,
): string | null {
  return chooseModel(prepareRouter(config), intent)
}

/**
 * Maps the configured alias to a concrete model. The compiled router snapshot
 * is cached per config object, so requests only classify the prompt and score
 * pre-normalized candidates. Callers apply model mappings afterwards.
 */
export function resolveRoutedModel(
  model: string,
  body: unknown,
  config: RouterConfig,
): string {
  const router = prepareRouter(config)
  if (!router.enabled) return model
  if (model !== router.alias && model.trim() !== router.alias) return model

  const prompt = analyzePrompt(body)
  const intent = classifyPrompt(prompt.text, prompt.hasImages)
  return chooseModel(router, intent) ?? model
}
