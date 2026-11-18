import {
  HTTPError,
  UpstreamHeadersTimeoutError,
  UpstreamStreamInactivityTimeoutError,
} from "./error"
import type { ComboTarget } from "./config-store"

/**
 * Runtime failover for combo models (`combo/<name>`). Combos group several
 * provider/model pairs; a request is sent to the first target and, if the
 * upstream rejects it before streaming starts, the next target is tried. This
 * keeps a virtual "free" model usable even when one provider is rate limited,
 * out of credit or temporarily down.
 */

export interface ComboLogger {
  warn: (message: string, ...args: Array<unknown>) => void
}

export function comboModelId(provider: string, model: string): string {
  return `${provider}/${model}`
}

/**
 * Regular targets keep their configured order; last-resort targets are only
 * tried after every regular target has failed.
 */
export function orderComboTargets(
  targets: Array<ComboTarget>,
): Array<ComboTarget> {
  const regular = targets.filter((target) => target.lastResort !== true)
  const lastResort = targets.filter((target) => target.lastResort === true)
  return [...regular, ...lastResort]
}

/**
 * Only failures raised before the upstream started streaming can be retried.
 * A streaming response has already been returned to the client, so mid-stream
 * errors must propagate instead of being retried.
 */
export function isRetryableComboError(error: unknown): boolean {
  return (
    error instanceof HTTPError
    || error instanceof UpstreamHeadersTimeoutError
    || error instanceof UpstreamStreamInactivityTimeoutError
  )
}

export interface ComboFailoverOptions {
  /** The requested combo id, for logging, e.g. `combo/coding-free`. */
  comboModel: string
  targets: Array<ComboTarget>
  /**
   * Runs the request for one concrete `provider/model` target. Returns the
   * client response, or throws before streaming when the upstream failed.
   */
  run: (
    targetModel: string,
    target: ComboTarget,
  ) => Response | Promise<Response>
  logger?: ComboLogger
}

export async function runComboFailover(
  options: ComboFailoverOptions,
): Promise<Response> {
  const { comboModel, targets, run, logger } = options
  const ordered = orderComboTargets(targets)
  let lastResponse: Response | undefined
  let lastError: unknown

  for (const target of ordered) {
    const targetModel = comboModelId(target.provider, target.model)
    try {
      const response = await run(targetModel, target)
      if (response.ok) {
        return response
      }
      lastResponse = response
      logger?.warn(
        `[combo] ${comboModel}: target ${targetModel} returned ${response.status}; trying next`,
      )
    } catch (error) {
      if (!isRetryableComboError(error)) {
        throw error
      }
      lastError = error
      logger?.warn(
        `[combo] ${comboModel}: target ${targetModel} failed; trying next`,
        error,
      )
    }
  }

  if (lastResponse) {
    return lastResponse
  }
  if (lastError instanceof HTTPError) {
    return lastError.response
  }
  if (lastError instanceof Error) {
    throw lastError
  }
  throw new Error(`Combo '${comboModel}' has no available target`)
}
