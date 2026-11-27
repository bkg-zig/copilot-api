import { getConfig } from "~/lib/config/config-store"
import {
  DEFAULT_ROUTER_ALIAS,
  resolveRoutedModel as resolveWithConfig,
} from "~/lib/router"
import type { RouterConfig } from "~/lib/types/config"

const DISABLED_ROUTER: RouterConfig = {
  enabled: false,
  alias: DEFAULT_ROUTER_ALIAS,
  pool: [],
}

/** Returns the in-memory config snapshot; no file or database read per request. */
export function getRouterConfig(): RouterConfig {
  const router = getConfig().router
  if (!router || typeof router !== "object" || Array.isArray(router)) {
    return DISABLED_ROUTER
  }
  return router
}

/** Request-facing alias resolution using the current config snapshot. */
export function resolveRoutedModel(model: string, body: unknown): string {
  return resolveWithConfig(model, body, getRouterConfig())
}
