import type { ProviderConfig } from "~/lib/types/config"

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com"

export type AnthropicKeyCheck =
  | { ok: true; apiKey: string }
  | { ok: false; error: string }

/**
 * Accepts official Claude API keys only. Claude subscription (OAuth) tokens are
 * restricted to Anthropic's own products and must not be routed through a gateway.
 */
export function checkAnthropicApiKey(value: unknown): AnthropicKeyCheck {
  const apiKey = typeof value === "string" ? value.trim() : ""
  if (apiKey.startsWith("sk-ant-oat") || apiKey.startsWith("sk-ant-ort")) {
    return {
      ok: false,
      error:
        "Claude-Abo-Tokens werden nicht unterstützt. Bitte einen API-Key aus der Anthropic Console verwenden.",
    }
  }
  if (!apiKey.startsWith("sk-ant-") || apiKey.length > 4096) {
    return {
      ok: false,
      error: "Ein gültiger Anthropic-API-Key (sk-ant-…) ist erforderlich.",
    }
  }
  return { ok: true, apiKey }
}

export function buildAnthropicProviderConfig(
  current: ProviderConfig,
  apiKey: string,
): ProviderConfig {
  return {
    ...current,
    type: "anthropic",
    baseUrl: ANTHROPIC_BASE_URL,
    authType: "x-api-key",
    apiKey,
    enabled: true,
  }
}
