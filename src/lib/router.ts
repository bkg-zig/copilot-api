import {
  getConfig,
  type RouterConfig,
  type RouterModelHint,
} from "./config-store"

export const DEFAULT_ROUTER_ALIAS = "auto"

const TEXT_KEYS = new Set([
  "text",
  "content",
  "input_text",
  "output_text",
  "prompt",
  "system",
  "instruction",
  "query",
])

const IMAGE_KEYS = new Set([
  "image_url",
  "image",
  "input_image",
  "image_base64",
  "source",
])

const CODE_PATTERN =
  /\b(code|function|class|method|bug|debug|error|exception|stack ?trace|refactor|compile|typescript|javascript|python|golang|rust|java|sql|regex|api|endpoint|repository|unit test|test case|algorithm)\b/i
const REASONING_PATTERN =
  /\b(analyze|analyse|architecture|design|prove|proof|step by step|plan|strategy|complex|optimize|optimise|trade-?off|compare|evaluate|research|deep dive|reason)\b/i
const SIMPLE_PATTERN =
  /\b(hi|hello|hey|thanks|thank you|what is|who is|define|translate|summarize|summarise|rewrite|list|name)\b/i
const SAFETY_PATTERN =
  /\b(safety|moderation|harmful|abuse|policy|toxic|content filter|classify)\b/i
const VISION_PATTERN =
  /\b(image|photo|picture|screenshot|diagram|chart|figure|render|draw|ocr|vision)\b/i
const LARGE_PROMPT_CHARS = 4000

interface ModelTraits {
  power: number
  vision: boolean
  code: boolean
  reasoning: boolean
  safety: boolean
  cost: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseBillions(model: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*b\b/i.exec(model)
  if (!match) {
    return null
  }
  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : null
}

function inferTraits(model: string, hint?: RouterModelHint): ModelTraits {
  const lower = model.toLowerCase()
  const params = parseBillions(lower)

  let power =
    params === null ? 50
    : params >= 300 ? 95
    : params >= 100 ? 82
    : params >= 50 ? 70
    : params >= 25 ? 55
    : params >= 12 ? 45
    : 32

  const premium = /(ultra|super|opus|max|large|pro\b|550b|120b)/.test(lower)
  const cheap =
    /(flash|mini|lightning|nano|tiny|small|\bxs\b|a3b|a4b|a55b)/.test(lower)
  if (premium) power += 8
  if (cheap) power -= 12
  power = clamp(power, 5, 100)

  let cost = power
  if (premium) cost += 10
  if (cheap) cost -= 20

  const traits: ModelTraits = {
    power,
    vision:
      /\b(vl|vision|multimodal|image)\b/.test(lower) || /diffusion/.test(lower),
    code: /(code|coder|deepseek|qwen|nemotron|gpt)/.test(lower),
    reasoning: /(reason|think|ultra|super|nemotron|deepseek|gpt)/.test(lower),
    safety: /(safety|guard|moderation|content)/.test(lower),
    cost: clamp(cost, 5, 100),
  }

  if (hint) {
    if (typeof hint.power === "number") traits.power = clamp(hint.power, 0, 100)
    if (typeof hint.cost === "number") traits.cost = clamp(hint.cost, 0, 100)
    if (hint.vision === true) traits.vision = true
    if (hint.code === true) traits.code = true
    if (hint.reasoning === true) traits.reasoning = true
    if (hint.safety === true) traits.safety = true
  }

  return traits
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

export function classifyPrompt(text: string, hasImages: boolean): PromptIntent {
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
    && chars < 400
    && SIMPLE_PATTERN.test(text)
  return { text, hasImages, chars, code, reasoning, simple, safety, vision }
}

export function getRouterConfig(): RouterConfig {
  const config = getConfig()
  const router = config.router
  if (!router || typeof router !== "object") {
    return { enabled: false, alias: DEFAULT_ROUTER_ALIAS, pool: [] }
  }
  return router
}

export function getRouterAlias(
  config: RouterConfig = getRouterConfig(),
): string {
  const alias = config.alias?.trim()
  return alias && alias.length > 0 ? alias : DEFAULT_ROUTER_ALIAS
}

export function isRouterAlias(model: string): boolean {
  const config = getRouterConfig()
  if (config.enabled !== true) {
    return false
  }
  return model.trim() === getRouterAlias(config)
}

function matchRule(intent: PromptIntent, config: RouterConfig): string | null {
  for (const rule of config.rules ?? []) {
    if (!rule?.match || !rule.model) continue
    let regex: RegExp
    try {
      regex = new RegExp(rule.match, rule.flags ?? "i")
    } catch {
      continue
    }
    if (regex.test(intent.text)) {
      return rule.model
    }
  }
  return null
}

function scoreModel(
  model: string,
  intent: PromptIntent,
  config: RouterConfig,
): number | null {
  const hint = config.modelHints?.[model]
  const traits = inferTraits(model, hint)

  if (intent.vision && !traits.vision) return null
  if (intent.safety && !traits.safety) return null

  // Simple prompts trade capability for speed and cost.
  let score =
    intent.simple ? traits.power * 0.25 - traits.cost * 0.75 : traits.power
  if (intent.code) score += traits.code ? 25 : -20
  if (intent.reasoning) score += traits.reasoning ? 25 : -10
  if (intent.chars >= LARGE_PROMPT_CHARS) score += traits.power * 0.15
  if (intent.safety) score += 30
  return score
}

export function selectRoutedModel(
  intent: PromptIntent,
  config: RouterConfig = getRouterConfig(),
): string | null {
  const pool = (config.pool ?? []).filter(
    (model): model is string =>
      typeof model === "string" && model.trim().length > 0,
  )
  const strategy = config.strategy ?? "auto"

  if (strategy === "rules" || strategy === "auto") {
    const ruleModel = matchRule(intent, config)
    if (ruleModel) return ruleModel
    if (strategy === "rules") return config.defaultModel ?? pool[0] ?? null
  }

  let best: string | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const model of pool) {
    const score = scoreModel(model, intent, config)
    if (score !== null && score > bestScore) {
      bestScore = score
      best = model
    }
  }
  return best ?? config.defaultModel ?? pool[0] ?? null
}

function collectText(value: unknown, out: string[], depth: number): void {
  if (depth > 12 || value === null || value === undefined) return
  if (typeof value === "string") {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, depth + 1)
    return
  }
  if (typeof value !== "object") return

  const record = value as Record<string, unknown>
  let matchedKey = false
  for (const [key, child] of Object.entries(record)) {
    if (TEXT_KEYS.has(key)) {
      matchedKey = true
      collectText(child, out, depth + 1)
    }
  }
  // Recurse into containers so nested message arrays are still walked.
  if (
    !matchedKey
    || Array.isArray(record.content)
    || Array.isArray(record.messages)
  ) {
    for (const child of Object.values(record)) {
      collectText(child, out, depth + 1)
    }
  }
}

function containsImage(value: unknown, depth: number): boolean {
  if (depth > 12 || value === null || value === undefined) return false
  if (Array.isArray(value)) {
    return value.some((item) => containsImage(item, depth + 1))
  }
  if (typeof value !== "object") return false
  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    if (IMAGE_KEYS.has(key) && child) {
      if (key === "source" && typeof child === "object") {
        const source = child as Record<string, unknown>
        if (source.type === "base64" || source.type === "url" || source.data) {
          return true
        }
      } else {
        return true
      }
    }
    if (containsImage(child, depth + 1)) return true
  }
  return false
}

export function extractPromptText(body: unknown): string {
  const out: string[] = []
  collectText(body, out, 0)
  return out.join("\n").slice(0, 20000)
}

export function bodyHasImage(body: unknown): boolean {
  return containsImage(body, 0)
}

/**
 * Returns the routed model id when `model` is the configured router alias,
 * otherwise returns `model` unchanged. The caller is expected to still run
 * model mappings afterwards.
 */
export function resolveRoutedModel(model: string, body: unknown): string {
  const config = getRouterConfig()
  if (config.enabled !== true) return model
  if (model.trim() !== getRouterAlias(config)) return model

  const intent = classifyPrompt(extractPromptText(body), bodyHasImage(body))
  const selected = selectRoutedModel(intent, config)
  return selected ?? model
}
