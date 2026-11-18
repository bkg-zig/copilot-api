/**
 * Codex/ChatGPT account capabilities — mirrors the capability detection from
 * codex-chatgpt-web (chatgpt-web-models.ts) so the gateway can do
 * account-aware model routing without running a browser.
 *
 * These are discovered by probing the ChatGPT web UI or the Codex backend.
 * In this gateway they come from the upstream Codex models endpoint or are
 * provided by the user during account setup.
 */

export type CodexCodexEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"

export type CodexAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max"

export type CodexModelFamily = "5.6" | "6"

export interface CodexAccountCapabilities {
  /** Account has access to the Sol model selector (Plus/Pro/Team). */
  solAvailable: boolean
  /** Account has Extra High reasoning mode (Plus with Extra High, Pro, Team). */
  extraHighAvailable: boolean
  /** Account is a Pro/Team subscription (Max effort, bigger context). */
  proAvailable: boolean
  /** Experimental Bigger Context feature enabled for this account. */
  experimentalBiggerContext: boolean
  /** Zero Risk (manual) interaction mode enabled. */
  browserInteractionMode: "automatic" | "manual"
  /** Zero Risk Pro context profile explicitly enabled. */
  zeroRiskProEnabled: boolean
}

/** Default capabilities for an unknown/new account. */
export const DEFAULT_CODEX_CAPABILITIES: CodexAccountCapabilities = {
  solAvailable: false,
  extraHighAvailable: false,
  proAvailable: false,
  experimentalBiggerContext: false,
  browserInteractionMode: "automatic",
  zeroRiskProEnabled: false,
}

/**
 * Probe the Codex backend to discover account capabilities.
 * This is called after login and can be refreshed.
 */
export async function probeCodexCapabilities(
  credentials: { accessToken: string; accountId: string },
  fetchFn: typeof fetch = fetch,
): Promise<CodexAccountCapabilities> {
  try {
    // Try to fetch the model catalog from Codex backend which may include
    // capability hints. The /codex/models endpoint sometimes exposes this.
    const response = await fetchFn(
      "https://chatgpt.com/backend-api/codex/models",
      {
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "user-agent": "copilot-api/1.0",
        },
        signal: AbortSignal.timeout(5_000),
      },
    )

    if (!response.ok) {
      return DEFAULT_CODEX_CAPABILITIES
    }

    interface CodexModelsResponse {
      models?: Array<CodexModel>
    }
    interface CodexModel {
      id: string
      reasoningEfforts?: Array<string>
    }

    const data = (await response.json()) as CodexModelsResponse

    // Heuristic capability detection from model list
    // If Sol models are present, solAvailable = true
    // If Pro models (gpt-6-pro, gpt-5.6-pro) are present, proAvailable = true
    // etc.

    const models: Array<CodexModel> = data.models ?? []
    const modelIds = new Set(models.map((m) => m.id))

    return {
      solAvailable: modelIds.has("gpt-5.6-sol") || modelIds.has("gpt-6-sol"),
      extraHighAvailable:
        modelIds.has("gpt-5.6-sol")
        && models.some(
          (m) => m.id.includes("sol") && m.reasoningEfforts?.includes("xhigh"),
        ),
      proAvailable: modelIds.has("gpt-5.6-pro") || modelIds.has("gpt-6-pro"),
      experimentalBiggerContext: false, // Would need explicit probe
      browserInteractionMode: "automatic",
      zeroRiskProEnabled: false,
    }
  } catch {
    return DEFAULT_CODEX_CAPABILITIES
  }
}

/**
 * Resolve context window limits for a given model/effort/account combination.
 * Mirrors the logic from codex-chatgpt-web's resolveChatGptWebContextLimits.
 */
export function resolveCodexContextLimits(
  modelId: string,
  effort: CodexAdapterEffort,
  capabilities: CodexAccountCapabilities,
  modelFamily: CodexModelFamily = "6",
): {
  contextWindow: number
  autoCompactTokenLimit: number
  effectiveContextWindowPercent: number
} {
  // Context window constants (from codex-chatgpt-web)
  const INSTANT_CONTEXT_WINDOW = 41_000
  const INSTANT_AUTO_COMPACT = 32_000
  const MEDIUM_HIGH_CONTEXT_WINDOW = 90_000
  const MEDIUM_HIGH_AUTO_COMPACT = 80_000
  const PRO_STANDARD_CONTEXT_WINDOW = 111_193 // 103_000 + 8_192 + 1
  const PRO_MODEL_CONTEXT_WINDOW = 112_193 // 104_000 + 8_192 + 1
  const PRO_AUTO_COMPACT = 95_000
  const LUNA_CONTEXT_WINDOW = 1_050_000
  const BIGGER_CONTEXT_MULTIPLIER = 3
  const GPT6_SOL_BIGGER_CONTEXT = 240_000
  const GPT6_SOL_BIGGER_AUTO_COMPACT = 220_000
  const GPT6_PLUS_BIGGER_CONTEXT = 120_000
  const GPT6_PLUS_BIGGER_AUTO_COMPACT = 110_000

  // Zero Risk handling
  if (capabilities.browserInteractionMode === "manual") {
    if (capabilities.zeroRiskProEnabled) {
      return {
        contextWindow: PRO_MODEL_CONTEXT_WINDOW * 3,
        autoCompactTokenLimit: PRO_AUTO_COMPACT * 3,
        effectiveContextWindowPercent: Math.round(
          ((PRO_AUTO_COMPACT * 3) / (PRO_MODEL_CONTEXT_WINDOW * 3)) * 100,
        ),
      }
    }
    return {
      contextWindow: INSTANT_CONTEXT_WINDOW * 3,
      autoCompactTokenLimit: INSTANT_AUTO_COMPACT * 3,
      effectiveContextWindowPercent: Math.round(
        ((INSTANT_AUTO_COMPACT * 3) / (INSTANT_CONTEXT_WINDOW * 3)) * 100,
      ),
    }
  }

  // Luna (Free tier) handling
  if (modelId.includes("luna") && !capabilities.solAvailable) {
    if (capabilities.experimentalBiggerContext) {
      const LUNA_BROWSER_BUDGET = 28_000
      const LUNA_BIGGER_CONTEXT =
        LUNA_BROWSER_BUDGET * BIGGER_CONTEXT_MULTIPLIER
      const LUNA_BIGGER_AUTO_COMPACT =
        (LUNA_BROWSER_BUDGET - 8_192) * BIGGER_CONTEXT_MULTIPLIER
      return {
        contextWindow: LUNA_BIGGER_CONTEXT,
        autoCompactTokenLimit: LUNA_BIGGER_AUTO_COMPACT,
        effectiveContextWindowPercent: Math.round(
          (LUNA_BIGGER_AUTO_COMPACT / LUNA_BIGGER_CONTEXT) * 100,
        ),
      }
    }
    return {
      contextWindow: LUNA_CONTEXT_WINDOW,
      autoCompactTokenLimit: LUNA_CONTEXT_WINDOW,
      effectiveContextWindowPercent: 100,
    }
  }

  let contextWindow: number
  let autoCompactTokenLimit: number

  if (capabilities.proAvailable) {
    if (effort === "low") {
      contextWindow = PRO_STANDARD_CONTEXT_WINDOW
    } else if (effort === "max") {
      contextWindow = PRO_MODEL_CONTEXT_WINDOW
    } else {
      contextWindow = PRO_STANDARD_CONTEXT_WINDOW
    }
    autoCompactTokenLimit = PRO_AUTO_COMPACT
  } else if (effort === "low") {
    contextWindow = INSTANT_CONTEXT_WINDOW
    autoCompactTokenLimit = INSTANT_AUTO_COMPACT
  } else if (
    effort === "medium"
    || effort === "high"
    || (effort === "xhigh" && capabilities.extraHighAvailable)
  ) {
    contextWindow = MEDIUM_HIGH_CONTEXT_WINDOW
    autoCompactTokenLimit = MEDIUM_HIGH_AUTO_COMPACT
  } else {
    // Fallback for unavailable effort
    contextWindow = INSTANT_CONTEXT_WINDOW
    autoCompactTokenLimit = INSTANT_AUTO_COMPACT
  }

  // Bigger Context multiplier
  if (capabilities.experimentalBiggerContext) {
    const supportsBiggerContext =
      modelId.includes("sol") && (modelFamily !== "6" || effort !== "low")

    if (supportsBiggerContext) {
      if (modelFamily === "6" && effort !== "max") {
        contextWindow =
          capabilities.proAvailable ?
            GPT6_SOL_BIGGER_CONTEXT
          : GPT6_PLUS_BIGGER_CONTEXT
        autoCompactTokenLimit =
          capabilities.proAvailable ?
            GPT6_SOL_BIGGER_AUTO_COMPACT
          : GPT6_PLUS_BIGGER_AUTO_COMPACT
      } else {
        contextWindow *= BIGGER_CONTEXT_MULTIPLIER
        autoCompactTokenLimit *= BIGGER_CONTEXT_MULTIPLIER
      }
    }
  }

  return {
    contextWindow,
    autoCompactTokenLimit,
    effectiveContextWindowPercent: Math.round(
      (autoCompactTokenLimit / contextWindow) * 100,
    ),
  }
}

/**
 * Filter available model routes based on account capabilities.
 * Returns the list of model IDs that should be visible for this account.
 */
export function filterCodexModelsByCapabilities(
  modelIds: string[],
  capabilities: CodexAccountCapabilities,
): string[] {
  return modelIds.filter((modelId) => {
    // Zero Risk mode: only Zero Risk models available
    if (capabilities.browserInteractionMode === "manual") {
      return modelId.includes("zero-risk")
    }

    // Luna-only accounts: only Luna models
    if (!capabilities.solAvailable) {
      return modelId.includes("luna")
    }

    // Sol accounts: filter by Pro/Extra High requirements
    if (modelId.includes("pro") && !capabilities.proAvailable) return false
    if (modelId.includes("extra-high") && !capabilities.extraHighAvailable)
      return false

    return true
  })
}
