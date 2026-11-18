import {
  defaultConfig,
  defaultContextManagement,
  getConfig,
  readEditableConfigFromDisk,
  reloadConfig,
  writeConfigToDisk,
  type ComboConfig,
  type CombosConfig,
  type ComboTarget,
  type VirtualModelConfig,
  type VirtualModelsConfig,
} from "./config-store"

export type {
  ComboConfig,
  CombosConfig,
  ComboTarget,
  VirtualModelConfig,
  VirtualModelsConfig,
}

const GPT_MODEL_PATTERN = /^gpt-(\d+)(?:\.(\d+))?/

function isGpt53OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 3
}

export function isGpt56OrAbove(model: string): boolean {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > 5) {
    return true
  }
  if (majorVersion !== 5) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= 6
}

const gpt5CommentaryPrompt = `# Working with the user

You interact with the user through a terminal. You have 2 ways of communicating with the users:  
- Share intermediary updates in \`commentary\` channel.  
- After you have completed all your work, send a message to the \`final\` channel.  

## Intermediary updates

- Intermediary updates go to the \`commentary\` channel.
- User updates are short updates while you are working, they are NOT final answers.
- You use 1-2 sentence user updates to communicate progress and new information to the user as you are doing work.
- Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements (“Done —”, “Got it”, “Great question, ”) or framing phrases.
- You provide user updates frequently, every 20s.
- Before exploring or doing substantial work, you start with a user update acknowledging the request and explaining your first step. You should include your understanding of the user request and explain what you will do. Avoid commenting on the request or using starters such as "Got it -" or "Understood -" etc.
- When exploring, e.g. searching, reading files, you provide user updates as you go, every 20s, explaining what context you are gathering and what you've learned. Vary your sentence structure when providing these updates to avoid sounding repetitive - in particular, don't start each sentence the same way.
- After you have sufficient context, and the work is substantial, you provide a longer plan (this is the only user update that may be longer than 2 sentences and can contain formatting).
- Before performing file edits of any kind, you provide updates explaining what edits you are making.
- As you are thinking, you very frequently provide updates even if not taking any actions, informing the user of your progress. You interrupt your thinking and send multiple updates in a row if thinking for more than 100 words.
- Tone of your updates MUST match your personality.`

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  const userPrompt = config.extraPrompts?.[model]
  if (userPrompt !== undefined) {
    return userPrompt
  }
  return isGpt53OrAbove(model) ? gpt5CommentaryPrompt : ""
}

export function getModelMappings(): Record<string, string> {
  const config = getConfig()
  const modelMappings = config.modelMappings
  if (!modelMappings) {
    return { ...defaultConfig.modelMappings }
  }

  const validMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (
      !sourceModel
      || typeof targetModel !== "string"
      || targetModel.length === 0
    ) {
      continue
    }
    validMappings[sourceModel] = targetModel
  }

  return validMappings
}

// Get the new virtual models configuration
export function getVirtualModelsConfig(): VirtualModelsConfig {
  const config = getConfig()
  if (!config.virtualModels) {
    return defaultConfig.virtualModels || { models: {}, defaults: {} }
  }
  return config.virtualModels
}

// Get all virtual models as a simple mapping (for backward compatibility)
export function getVirtualModelMappings(): Record<string, string> {
  const virtualModels = getVirtualModelsConfig()
  const mappings: Record<string, string> = {}

  for (const [name, vm] of Object.entries(virtualModels.models)) {
    if (vm.enabled !== false && vm.target) {
      mappings[name] = vm.target
    }
  }

  // Plain modelMappings win: they are what the user edits in the dashboard
  // and CLI, while virtualModels also carries built-in defaults.
  Object.assign(mappings, getModelMappings())

  return mappings
}

// Get full virtual model config for a specific virtual model
export function getVirtualModel(name: string): VirtualModelConfig | undefined {
  const virtualModels = getVirtualModelsConfig()
  return virtualModels.models[name]
}

// Check if a provider is allowed to serve a virtual model
export function isProviderAllowedForVirtualModel(
  virtualModelName: string,
  providerName: string,
): boolean {
  const vm = getVirtualModel(virtualModelName)
  if (!vm || !vm.allowedProviders || vm.allowedProviders.length === 0) {
    return true // No restrictions
  }
  return vm.allowedProviders.includes(providerName)
}

// Get context window for a virtual model
export function getVirtualModelContextWindow(
  virtualModelName: string,
): number | undefined {
  const vm = getVirtualModel(virtualModelName)
  if (!vm) return undefined
  return vm.contextWindow ?? getVirtualModelsConfig().defaults?.contextWindow
}

// Get version for a virtual model
export function getVirtualModelVersion(
  virtualModelName: string,
): "v1" | "base" | "v2" {
  const vm = getVirtualModel(virtualModelName)
  if (!vm) return getVirtualModelsConfig().defaults?.version ?? "base"
  return vm.version ?? getVirtualModelsConfig().defaults?.version ?? "base"
}

// Get v2 thread limit for a virtual model
export function getVirtualModelV2ThreadLimit(
  virtualModelName: string,
): number | undefined {
  const vm = getVirtualModel(virtualModelName)
  if (!vm) return getVirtualModelsConfig().defaults?.v2ThreadLimit
  return vm.v2ThreadLimit ?? getVirtualModelsConfig().defaults?.v2ThreadLimit
}

function validateVirtualModelConfig(
  models: Record<string, VirtualModelConfig>,
): Record<string, VirtualModelConfig> {
  const validated: Record<string, VirtualModelConfig> = {}
  for (const [name, vm] of Object.entries(models)) {
    if (!name || !vm.target) {
      continue // Skip invalid entries
    }
    validated[name] = {
      target: vm.target,
      allowedProviders: vm.allowedProviders?.filter(
        (p) => typeof p === "string" && p.length > 0,
      ),
      contextWindow:
        typeof vm.contextWindow === "number" && vm.contextWindow > 0 ?
          vm.contextWindow
        : undefined,
      version:
        ["v1", "base", "v2"].includes(vm.version ?? "") ?
          vm.version
        : undefined,
      v2ThreadLimit:
        typeof vm.v2ThreadLimit === "number" && vm.v2ThreadLimit > 0 ?
          vm.v2ThreadLimit
        : undefined,
      enabled: vm.enabled !== false,
      description: vm.description,
      tags: vm.tags?.filter((t) => typeof t === "string" && t.length > 0),
    }
  }
  return validated
}

export function setVirtualModelsConfig(
  virtualModels: VirtualModelsConfig,
): VirtualModelsConfig {
  const nextConfig = {
    ...readEditableConfigFromDisk(),
    virtualModels: {
      models: validateVirtualModelConfig(virtualModels.models),
      defaults: virtualModels.defaults,
    },
  }

  writeConfigToDisk(nextConfig)
  reloadConfig()
  return getVirtualModelsConfig()
}

// Add or update a single virtual model
export function upsertVirtualModel(
  name: string,
  config: VirtualModelConfig,
): VirtualModelsConfig {
  const current = getVirtualModelsConfig()
  const updated = {
    ...current,
    models: {
      ...current.models,
      [name]: config,
    },
  }
  return setVirtualModelsConfig(updated)
}

// Remove a virtual model
export function removeVirtualModel(name: string): VirtualModelsConfig {
  const current = getVirtualModelsConfig()
  const { [name]: removed, ...rest } = current.models
  return setVirtualModelsConfig({ ...current, models: rest })
}

// Legacy function for backward compatibility
function validateModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const validatedMappings: Record<string, string> = {}
  for (const [sourceModel, targetModel] of Object.entries(modelMappings)) {
    if (!sourceModel || !targetModel) {
      throw new Error(
        "Each model mapping must use non-empty source and target values.",
      )
    }
    validatedMappings[sourceModel] = targetModel
  }

  return validatedMappings
}

export function setModelMappings(
  modelMappings: Record<string, string>,
): Record<string, string> {
  const nextConfig = {
    ...readEditableConfigFromDisk(),
    modelMappings: validateModelMappings(modelMappings),
  }

  writeConfigToDisk(nextConfig)
  reloadConfig()
  return getModelMappings()
}

export function resolveMappedModel(model: string): string {
  return getVirtualModelMappings()[model] ?? model
}

// Combo functions
export function getCombosConfig(): CombosConfig {
  const config = getConfig()
  if (!config.combos) {
    return defaultConfig.combos || { combos: {} }
  }
  return config.combos
}

export function getCombo(name: string): ComboConfig | undefined {
  const combos = getCombosConfig()
  return combos.combos[name]
}

export function getAllCombos(): Record<string, ComboConfig> {
  const combos = getCombosConfig()
  return { ...combos.combos }
}

function validateComboConfig(
  combos: Record<string, ComboConfig>,
): Record<string, ComboConfig> {
  const validated: Record<string, ComboConfig> = {}
  for (const [name, combo] of Object.entries(combos)) {
    if (
      !name
      || !combo.targets
      || !Array.isArray(combo.targets)
      || combo.targets.length === 0
    ) {
      continue // Skip invalid entries
    }
    const validTargets = combo.targets.filter((t) => t.provider && t.model)
    if (validTargets.length === 0) continue

    validated[name] = {
      targets: validTargets.map((t) => ({
        provider: t.provider,
        model: t.model,
        weight:
          typeof t.weight === "number" && t.weight > 0 ?
            Math.min(t.weight, 10000)
          : 1,
        lastResort: t.lastResort === true,
        metered: t.metered === true,
      })),
      strategy:
        (
          [
            "failover",
            "round-robin",
            "random",
            "least-used",
            "reset-window",
            "jev",
          ].includes(combo.strategy ?? "")
        ) ?
          combo.strategy
        : "failover",
      stickyLimit:
        typeof combo.stickyLimit === "number" && combo.stickyLimit > 0 ?
          Math.min(combo.stickyLimit, 100)
        : 1,
      cooldownMs:
        typeof combo.cooldownMs === "number" && combo.cooldownMs > 0 ?
          Math.min(combo.cooldownMs, 600000)
        : undefined,
      waitForCooldownMs:
        (
          typeof combo.waitForCooldownMs === "number"
          && combo.waitForCooldownMs >= 0
        ) ?
          Math.min(combo.waitForCooldownMs, 600000)
        : 0,
      cooldownWaitPolicy:
        combo.cooldownWaitPolicy === "before-last-resort" ?
          "before-last-resort"
        : undefined,
      defaultEffort:
        (
          ["low", "medium", "high", "xhigh", "max", "ultra", null].includes(
            combo.defaultEffort ?? "",
          )
        ) ?
          combo.defaultEffort
        : undefined,
      defaultEffortMode:
        ["fallback", "force"].includes(combo.defaultEffortMode ?? "") ?
          combo.defaultEffortMode
        : "fallback",
      reasoningEffortMode:
        ["strict", "adaptive"].includes(combo.reasoningEffortMode ?? "") ?
          combo.reasoningEffortMode
        : "strict",
      jevEffortMode:
        ["decide", "client"].includes(combo.jevEffortMode ?? "") ?
          combo.jevEffortMode
        : "decide",
      imageInput:
        ["auto", "disabled"].includes(combo.imageInput ?? "") ?
          combo.imageInput
        : "auto",
      alias: combo.alias,
      nativeAlias: combo.nativeAlias === true,
      displayName: combo.displayName,
      decisionProvider: combo.decisionProvider,
      decisionModel: combo.decisionModel,
      decisionTimeoutMs:
        (
          typeof combo.decisionTimeoutMs === "number"
          && combo.decisionTimeoutMs >= 1000
        ) ?
          Math.min(combo.decisionTimeoutMs, 120000)
        : 4000,
      decisionQuotaSignals: combo.decisionQuotaSignals === true,
      decisionQuotaTiers: combo.decisionQuotaTiers,
      sessionPin:
        (
          combo.sessionPin
          && typeof combo.sessionPin.ttlMs === "number"
          && combo.sessionPin.ttlMs >= 60000
        ) ?
          { ttlMs: Math.min(combo.sessionPin.ttlMs, 86400000) }
        : null,
      enabled: combo.enabled !== false,
      description: combo.description,
      tags: combo.tags?.filter((t) => typeof t === "string" && t.length > 0),
    }
  }
  return validated
}

export function setCombosConfig(combos: CombosConfig): CombosConfig {
  const nextConfig = {
    ...readEditableConfigFromDisk(),
    combos: {
      combos: validateComboConfig(combos.combos),
    },
  }

  writeConfigToDisk(nextConfig)
  reloadConfig()
  return getCombosConfig()
}

export function upsertCombo(name: string, config: ComboConfig): CombosConfig {
  const current = getCombosConfig()
  const updated = {
    ...current,
    combos: {
      ...current.combos,
      [name]: config,
    },
  }
  return setCombosConfig(updated)
}

export function removeCombo(name: string): CombosConfig {
  const current = getCombosConfig()
  const { [name]: removed, ...rest } = current.combos
  return setCombosConfig({ ...current, combos: rest })
}

// Get combo targets for a combo model (e.g., "combo/main")
export function resolveComboModel(model: string): ComboTarget[] | undefined {
  if (!model.startsWith("combo/")) return undefined
  const comboName = model.slice(6)
  const combo = getCombo(comboName)
  if (!combo || combo.enabled === false) return undefined
  return combo.targets
}

export function getSmallModel(): string {
  return getSmallModelForProvider("copilot") ?? "gpt-6-luna"
}

export function getSmallModelForProvider(provider: string): string | undefined {
  const providerName = provider.trim()
  const configuredModels = getConfig().smallModels
  const model =
    configuredModels && Object.hasOwn(configuredModels, providerName) ?
      configuredModels[providerName]
    : defaultConfig.smallModels?.[providerName]

  return typeof model === "string" ? model.trim() || undefined : undefined
}

export function isContextManagementEnabledForMessages(): boolean {
  const config = getConfig()
  return config.contextManagement?.messages ?? defaultContextManagement.messages
}

export function isContextManagementEnabledForResponses(): boolean {
  const config = getConfig()
  return (
    config.contextManagement?.responses ?? defaultContextManagement.responses
  )
}

export function getModelResponsesApiCompactThreshold(
  model: string,
): number | undefined {
  const config = getConfig()
  const threshold = config.modelResponsesApiCompactThresholds?.[model]

  if (
    typeof threshold !== "number"
    || !Number.isFinite(threshold)
    || threshold <= 0
  ) {
    return undefined
  }

  return threshold
}

export function isOutputEncryptedContentDisabled(model: string): boolean {
  const models = getConfig().noEncryptedOutputModels
  return Array.isArray(models) && models.includes(model)
}

export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const config = getConfig()
  const userEffort = config.modelReasoningEfforts?.[model]
  if (userEffort !== undefined) {
    return userEffort
  }
  return isGpt53OrAbove(model) ? "xhigh" : "high"
}
