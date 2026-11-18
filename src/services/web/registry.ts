import { chatgptWebAdapter } from "./chatgpt"
import { claudeWebAdapter } from "./claude"
import { deepseekWebAdapter } from "./deepseek"
import { geminiWebAdapter } from "./gemini"
import { grokWebAdapter } from "./grok"
import { inceptionWebAdapter } from "./inception"
import { qwenWebAdapter } from "./qwen"
import type { WebProviderAdapter } from "./types"

const ADAPTERS: Array<WebProviderAdapter> = [
  chatgptWebAdapter,
  claudeWebAdapter,
  deepseekWebAdapter,
  qwenWebAdapter,
  geminiWebAdapter,
  grokWebAdapter,
  inceptionWebAdapter,
]

const byId = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]))

export function getWebAdapter(
  id: string | undefined,
): WebProviderAdapter | null {
  if (!id) return null
  return byId.get(id.trim()) ?? null
}

export function listWebAdapters(): Array<WebProviderAdapter> {
  return [...ADAPTERS]
}

export function isWebAdapterId(id: string | undefined): boolean {
  return getWebAdapter(id) !== null
}
