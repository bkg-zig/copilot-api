/**
 * Per-account web rate limiting, following the zerokey pattern: a provider
 * 429 sets a cooldown for that account, and a minimum gap keeps bursts away
 * from web backends that ban aggressive clients. 401/429 are never retried
 * blindly by callers; they surface as session/rate errors instead.
 */

interface SlotState {
  cooldownUntil: number
  lastAt: number
}

const states = new Map<string, SlotState>()
const MIN_GAP_MS = 350

export function setWebCooldown(label: string, ms: number): void {
  const state = states.get(label) ?? { cooldownUntil: 0, lastAt: 0 }
  state.cooldownUntil = Date.now() + Math.max(0, ms)
  states.set(label, state)
}

export function resetWebRateLimits(): void {
  states.clear()
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("The request was aborted."))
      return
    }
    const timer = setTimeout(resolve, Math.max(0, ms))
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new Error("The request was aborted."))
      },
      { once: true },
    )
  })

export async function acquireWebSlot(
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const state = states.get(label) ?? { cooldownUntil: 0, lastAt: 0 }
  states.set(label, state)
  const now = Date.now()
  const wait = Math.max(
    state.cooldownUntil - now,
    MIN_GAP_MS - (now - state.lastAt),
    0,
  )
  if (wait > 0) await sleep(wait, signal)
  state.lastAt = Date.now()
}

export function cooldownRemainingMs(label: string): number {
  const state = states.get(label)
  return state ? Math.max(0, state.cooldownUntil - Date.now()) : 0
}
