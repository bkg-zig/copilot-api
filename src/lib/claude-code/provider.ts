import { readEditableConfigFromDisk, setProviderConfig } from "~/lib/config"

/**
 * Keeps config.providers.anthropic in sync with the gateway-owned Claude
 * subscription sign-in. Existing model filters and other provider options are
 * preserved; only the transport fields that the OAuth flow owns are replaced.
 */
export function syncClaudeProviderConfig(enable = true): void {
  const existing = readEditableConfigFromDisk().providers?.anthropic ?? {}
  const { apiKey: _apiKey, modelsDevProviderId: _catalog, ...rest } = existing
  setProviderConfig("anthropic", {
    ...rest,
    type: "anthropic",
    enabled: enable ? true : existing.enabled,
    baseUrl: rest.baseUrl?.trim() || "https://api.anthropic.com",
    authType: "oauth2",
  })
}
