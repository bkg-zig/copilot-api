import type { ResolvedProviderConfig } from "~/lib/provider-config"
import type { ChatCompletionsPayload } from "~/lib/types/chat-completions"
import type { Model } from "~/lib/types/models"

/** How a web session was handed to the gateway. Secrets are never echoed back. */
export type WebSessionKind = "cookie" | "token" | "fetch-capture" | "none"

export interface WebSessionInput {
  kind: WebSessionKind
  /** Raw cookie header, bearer token, or session cookie value. */
  value?: string
}

export interface WebSessionStatus {
  accountLabel: string
  modelCount: number
  expiresAt?: number
}

export class WebSessionError extends Error {
  readonly status: number
  readonly code: string
  readonly loginHint: string

  constructor(
    status: number,
    code: string,
    loginHint: string,
    message?: string,
  ) {
    super(message ?? loginHint)
    this.name = "WebSessionError"
    this.status = status
    this.code = code
    this.loginHint = loginHint
  }
}

export interface WebChatOptions {
  clientSignal?: AbortSignal
  signal?: AbortSignal
  fetchFn?: typeof fetch
}

/** The effective abort signal from either calling convention. */
export function webSignal(options?: WebChatOptions): AbortSignal | undefined {
  return options?.signal ?? options?.clientSignal
}

/**
 * One web provider (ChatGPT Web, Claude Web, ...). Implementations talk to
 * the provider's own web backend with the user's browser session and answer
 * in OpenAI Chat Completions format. They must never log session values.
 */
export interface WebProviderAdapter {
  id: string
  displayName: string
  webUrl: string
  loginHint: string
  sessionKinds: Array<WebSessionKind>
  validateSession(
    input: WebSessionInput,
    options?: WebChatOptions,
  ): Promise<WebSessionStatus>
  listModels(
    input: WebSessionInput,
    options?: WebChatOptions,
  ): Promise<Array<Model>>
  chatCompletion(
    providerConfig: ResolvedProviderConfig,
    payload: ChatCompletionsPayload,
    options?: WebChatOptions,
  ): Promise<Response>
}

/** Session material as stored on a resolved provider config. */
export function sessionInputFromConfig(
  providerConfig: ResolvedProviderConfig,
): WebSessionInput {
  if (providerConfig.cookie?.trim()) {
    return { kind: "cookie", value: providerConfig.cookie.trim() }
  }
  if (providerConfig.apiKey?.trim()) {
    return { kind: "token", value: providerConfig.apiKey.trim() }
  }
  return { kind: "none" }
}

export function webModel(id: string, name: string, vendor: string): Model {
  return {
    capabilities: {
      family: vendor,
      limits: { max_output_tokens: 16384 },
      object: "model_capabilities",
      supports: {
        parallel_tool_calls: false,
        streaming: true,
        tool_calls: false,
        vision: false,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name,
    object: "model",
    preview: false,
    vendor,
    version: "web",
    supported_endpoints: ["/v1/chat/completions"],
  }
}

export function stripAdapterPrefix(model: string, adapterId: string): string {
  const prefix = `${adapterId}/`
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}
