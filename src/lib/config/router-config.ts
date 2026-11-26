import type {
  RouterConfig,
  RouterModelHint,
  RouterRule,
  RouterStrategy,
} from "~/lib/types/config"

export class RouterConfigError extends Error {}

const ROUTER_FIELDS = new Set([
  "alias",
  "defaultModel",
  "enabled",
  "modelHints",
  "pool",
  "rules",
  "strategy",
])
const RULE_FIELDS = new Set(["flags", "match", "model"])
const HINT_FIELDS = new Set([
  "code",
  "cost",
  "power",
  "reasoning",
  "safety",
  "vision",
])
const STRATEGIES = new Set<RouterStrategy>(["auto", "heuristic", "rules"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key))
      throw new RouterConfigError(`Unknown ${label} field: ${key}`)
  }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  required: boolean,
): string | undefined {
  const value = record[key]
  if (value === undefined) {
    if (required) throw new RouterConfigError(`${key} is required.`)
    return undefined
  }
  if (typeof value !== "string")
    throw new RouterConfigError(`${key} must be a string.`)
  const trimmed = value.trim()
  if (required && !trimmed)
    throw new RouterConfigError(`${key} cannot be empty.`)
  return trimmed
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean")
    throw new RouterConfigError(`${key} must be a boolean.`)
  return value
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RouterConfigError(`${key} must be a number between 0 and 100.`)
  }
  if (value < 0 || value > 100) {
    throw new RouterConfigError(`${key} must be between 0 and 100.`)
  }
  return value
}

function readPool(value: unknown): Array<string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value))
    throw new RouterConfigError("pool must be an array.")
  const pool: Array<string> = []
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new RouterConfigError("pool entries must be non-empty model ids.")
    }
    const model = entry.trim()
    if (!pool.includes(model)) pool.push(model)
  }
  return pool
}

function readRules(value: unknown): Array<RouterRule> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value))
    throw new RouterConfigError("rules must be an array.")
  return value.map((entry) => {
    if (!isRecord(entry))
      throw new RouterConfigError("Each rule must be an object.")
    assertFields(entry, RULE_FIELDS, "rule")
    const match = optionalString(entry, "match", true)!
    const model = optionalString(entry, "model", true)!
    const flags = optionalString(entry, "flags", false)
    const effectiveFlags = flags?.replaceAll(/[gy]/g, "") || "i"
    try {
      new RegExp(match, effectiveFlags)
    } catch {
      throw new RouterConfigError(`Invalid rule pattern: ${match}`)
    }
    return {
      match,
      model,
      ...(flags === undefined ? {} : { flags: effectiveFlags }),
    }
  })
}

function readHints(
  value: unknown,
): Record<string, RouterModelHint> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value))
    throw new RouterConfigError("modelHints must be an object.")
  const hints: Record<string, RouterModelHint> = {}
  for (const [rawModel, rawHint] of Object.entries(value)) {
    const model = rawModel.trim()
    if (!model) throw new RouterConfigError("modelHints keys cannot be empty.")
    if (!isRecord(rawHint))
      throw new RouterConfigError(`Hint for ${model} must be an object.`)
    assertFields(rawHint, HINT_FIELDS, "model hint")

    const hint: RouterModelHint = {}
    const power = optionalNumber(rawHint, "power")
    const cost = optionalNumber(rawHint, "cost")
    if (power !== undefined) hint.power = power
    if (cost !== undefined) hint.cost = cost
    for (const key of ["code", "reasoning", "safety", "vision"] as const) {
      const flag = optionalBoolean(rawHint, key)
      if (flag !== undefined) hint[key] = flag
    }
    hints[model] = hint
  }
  return hints
}

/** Validates and cleans admin input without touching the config file. */
export function parseRouterConfig(input: unknown): RouterConfig {
  if (!isRecord(input))
    throw new RouterConfigError("Router config must be an object.")
  assertFields(input, ROUTER_FIELDS, "router")

  const config: RouterConfig = {}
  const enabled = optionalBoolean(input, "enabled")
  const alias = optionalString(input, "alias", false)
  const pool = readPool(input.pool)
  const rules = readRules(input.rules)
  const defaultModel = optionalString(input, "defaultModel", false)
  const modelHints = readHints(input.modelHints)
  const rawStrategy = optionalString(input, "strategy", false)
  let strategy: RouterStrategy | undefined
  if (rawStrategy !== undefined) {
    if (!STRATEGIES.has(rawStrategy as RouterStrategy)) {
      throw new RouterConfigError(`Unknown router strategy: ${rawStrategy}`)
    }
    strategy = rawStrategy as RouterStrategy
  }

  if (enabled !== undefined) config.enabled = enabled
  if (alias !== undefined) config.alias = alias
  if (pool !== undefined) config.pool = pool
  if (strategy !== undefined) config.strategy = strategy
  if (rules !== undefined) config.rules = rules
  if (defaultModel !== undefined) config.defaultModel = defaultModel
  if (modelHints !== undefined) config.modelHints = modelHints
  return config
}
