import fs from "node:fs/promises"
import path from "node:path"

const appDir = process.env.COPILOT_API_HOME || "/data"
const configPath = path.join(appDir, "config.json")
const readSecret = async (variable: string): Promise<string> => {
  const file = process.env[variable]
  if (!file) throw new Error(`${variable} is not configured`)
  const value = (await fs.readFile(file, "utf8")).trim()
  if (!value) throw new Error(`${variable} points to an empty secret`)
  return value
}

const [upstreamUrl, upstreamKey, gatewayKey] = await Promise.all([
  readSecret("BKG_API_GLOBAL_URL_FILE"),
  readSecret("BKG_API_GLOBAL_KEY_FILE"),
  readSecret("BKG_OV_GATEWAY_KEY_FILE"),
])
const parsedUrl = new URL(upstreamUrl)
if (
  parsedUrl.protocol !== "https:"
  || parsedUrl.hostname !== "api.eysho.info"
) {
  throw new Error("api_global URL must point to https://api.eysho.info")
}

interface ProviderEntry extends Record<string, unknown> {
  manualModels?: unknown
  disabledModels?: unknown
  models?: unknown
}

interface GatewayConfig extends Record<string, unknown> {
  auth?: Record<string, unknown>
  providers?: Record<string, ProviderEntry>
}

let config: GatewayConfig = {}
try {
  const raw = await fs.readFile(configPath, "utf8")
  if (raw.trim()) config = JSON.parse(raw) as GatewayConfig
} catch (error) {
  if (
    !(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ENOENT"
    )
  ) {
    throw error
  }
}

config.auth = {
  ...(config.auth ?? {}),
  apiKeyConfigs: [
    {
      id: "bkg-ov-clients",
      name: "BKG-OV, Claude Code and OpenCode",
      key: gatewayKey,
      enabled: true,
      allowedModels: ["bkg-api/*"],
    },
  ],
}
const configuredProviders = config.providers ?? {}
const reservedProviderNames = new Set([
  "copilot",
  "github-copilot",
  "codex",
  "xai",
  "bkg-api",
])
const userProviders = Object.fromEntries(
  Object.entries(configuredProviders).filter(
    ([name]) => !reservedProviderNames.has(name),
  ),
)
const previousBkgProvider: ProviderEntry = configuredProviders["bkg-api"] ?? {}
config.providers = {
  ...userProviders,
  "github-copilot": { enabled: false },
  codex: { enabled: false },
  xai: { enabled: false },
  "bkg-api": {
    // The central api_global endpoint and credentials are system-managed.
    // Preserve only the admin-managed model additions and per-model switches.
    manualModels: previousBkgProvider.manualModels ?? [],
    disabledModels: previousBkgProvider.disabledModels ?? [],
    models: previousBkgProvider.models ?? {},
    type: "openai-compatible",
    enabled: true,
    baseUrl: parsedUrl.origin,
    authType: "authorization",
    apiKey: upstreamKey,
  },
}
config.modelMappings = {}
config.smallModels = {}
config.claudeAutoModel = ""
config.messageApiWebSearchModel = ""
config.alphaSearchModel = ""
config.alphaSearchCodexPriority = false
config.useResponsesApiWebSearch = false
config.useMessagesApi = true
config.useResponsesApiWebSocket = false

await fs.mkdir(appDir, { recursive: true, mode: 0o700 })
const temporaryPath = `${configPath}.${process.pid}.tmp`
await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
})
await fs.chmod(temporaryPath, 0o600)
await fs.rename(temporaryPath, configPath)
console.log(
  "BKG gateway configuration loaded: api_global -> bkg-api; model catalog is discovered and completion-health filtered at runtime",
)
