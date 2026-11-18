import type { ResolvedProviderApiKey } from "./provider-config"

/** Rolling window used to enforce a key's optional `rpm` budget. */
export const PROVIDER_KEY_RPM_WINDOW_MS = 60_000
/** Cooldown after an upstream 429 before a key is tried again. */
export const PROVIDER_KEY_RATE_LIMIT_COOLDOWN_MS = 60_000
/** Cooldown after an upstream 401/403; the key is likely invalid or revoked. */
export const PROVIDER_KEY_AUTH_FAILURE_COOLDOWN_MS = 10 * 60_000

interface KeyRuntime {
  usedInWindow: number
  windowStartedAt: number
  cooldownUntil: number
}

interface PoolRuntime {
  cursor: number
  keys: Map<string, KeyRuntime>
}

const pools = new Map<string, PoolRuntime>()

function poolFor(providerName: string): PoolRuntime {
  let pool = pools.get(providerName)
  if (!pool) {
    pool = { cursor: 0, keys: new Map() }
    pools.set(providerName, pool)
  }
  return pool
}

function runtimeFor(pool: PoolRuntime, key: string): KeyRuntime {
  let runtime = pool.keys.get(key)
  if (!runtime) {
    runtime = { usedInWindow: 0, windowStartedAt: 0, cooldownUntil: 0 }
    pool.keys.set(key, runtime)
  }
  return runtime
}

function isWithinRpmBudget(
  entry: ResolvedProviderApiKey,
  runtime: KeyRuntime | undefined,
  now: number,
): boolean {
  if (entry.rpm === undefined || !runtime) return true
  if (now - runtime.windowStartedAt >= PROVIDER_KEY_RPM_WINDOW_MS) return true
  return runtime.usedInWindow < entry.rpm
}

/**
 * Picks the next API key for a provider: round-robin across the enabled keys,
 * skipping keys in cooldown and keys that reached their per-minute budget. When
 * every key is throttled the least-throttled key is still returned so the
 * request is attempted instead of failing locally.
 *
 * Selection is process-local and best effort; the gateway is expected to run a
 * single instance per config.
 */
export function selectProviderApiKey(
  providerName: string,
  keys: ReadonlyArray<ResolvedProviderApiKey>,
  now: number = Date.now(),
): string | undefined {
  if (keys.length === 0) return undefined
  if (keys.length === 1) return keys[0].key

  const pool = poolFor(providerName)
  const indexed = keys.map((entry, index) => ({ entry, index }))
  const notCoolingDown = indexed.filter(({ entry }) => {
    const runtime = pool.keys.get(entry.key)
    return !runtime || runtime.cooldownUntil <= now
  })
  const base = notCoolingDown.length > 0 ? notCoolingDown : indexed

  const withinBudget = base.filter(({ entry }) =>
    isWithinRpmBudget(entry, pool.keys.get(entry.key), now),
  )
  const candidates = withinBudget.length > 0 ? withinBudget : base

  const count = keys.length
  const rotated = [...candidates].sort((a, b) => {
    const offsetA = (a.index - pool.cursor + count) % count
    const offsetB = (b.index - pool.cursor + count) % count
    return offsetA - offsetB
  })
  const chosen = rotated[0]
  pool.cursor = (chosen.index + 1) % count

  const runtime = runtimeFor(pool, chosen.entry.key)
  if (now - runtime.windowStartedAt >= PROVIDER_KEY_RPM_WINDOW_MS) {
    runtime.windowStartedAt = now
    runtime.usedInWindow = 0
  }
  runtime.usedInWindow += 1
  return chosen.entry.key
}

/**
 * Records the upstream outcome for one key so later selections can avoid it.
 * Never throws; the pool is advisory bookkeeping only.
 */
export function noteProviderApiKeyResult(
  providerName: string,
  key: string | undefined,
  status: number,
  now: number = Date.now(),
): void {
  if (!key) return
  const runtime = runtimeFor(poolFor(providerName), key)
  if (status === 429) {
    runtime.cooldownUntil = now + PROVIDER_KEY_RATE_LIMIT_COOLDOWN_MS
    return
  }
  if (status === 401 || status === 403) {
    runtime.cooldownUntil = now + PROVIDER_KEY_AUTH_FAILURE_COOLDOWN_MS
    return
  }
  if (status >= 200 && status < 300) {
    runtime.cooldownUntil = 0
  }
}

/** Test hook: forget all rotation, cooldown and rate-limit state. */
export function resetProviderApiKeyPools(): void {
  pools.clear()
}
