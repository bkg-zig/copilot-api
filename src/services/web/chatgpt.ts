import type { ResolvedProviderConfig } from "~/lib/provider-config"
import { createChatGPTWebChatCompletion } from "~/services/chatgpt/chat-completions"
import { CHATGPT_LOGIN_HINT } from "~/services/chatgpt/cookie-session"
import { getChatGPTWebModels } from "~/services/chatgpt/models"
import { resolveChatGPTWebSession } from "~/services/chatgpt/web-client"

import {
  sessionInputFromConfig,
  WebSessionError,
  type WebProviderAdapter,
  type WebSessionInput,
} from "./types"

async function statusOf(input: WebSessionInput) {
  if (input.kind === "none" || !input.value) {
    throw new WebSessionError(401, "chatgpt_login_required", CHATGPT_LOGIN_HINT)
  }
  const credentials = {
    apiKey: input.kind === "token" ? input.value : "",
    baseUrl: "",
    cookie: input.kind === "cookie" ? input.value : undefined,
  }
  const session = await resolveChatGPTWebSession(credentials)
  const models = await getChatGPTWebModels(credentials)
  return {
    session,
    status: {
      accountLabel: session.accountId ?? "ChatGPT Web",
      modelCount: models.length,
    },
    models,
  }
}

export const chatgptWebAdapter: WebProviderAdapter = {
  id: "chatgpt",
  displayName: "ChatGPT (Web)",
  webUrl: "https://chatgpt.com",
  loginHint: CHATGPT_LOGIN_HINT,
  sessionKinds: ["cookie", "token", "fetch-capture"],
  async validateSession(input) {
    return (await statusOf(input)).status
  },
  async listModels(input) {
    return (await statusOf(input)).models
  },
  async chatCompletion(
    providerConfig: ResolvedProviderConfig,
    payload,
    options,
  ) {
    // The legacy `type: "chatgpt"` path stays byte-identical; this adapter is
    // the same implementation behind the generic web contract.
    void sessionInputFromConfig(providerConfig)
    return createChatGPTWebChatCompletion(providerConfig, payload, {
      clientSignal: options?.clientSignal,
    })
  },
}
