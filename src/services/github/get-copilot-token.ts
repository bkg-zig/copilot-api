import consola from "consola"

import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { redactText } from "~/lib/redact"
import { state } from "~/lib/state"

// Without arguments the token of the running Copilot runtime is used; the
// dashboard sign-in passes a new account's token to check it before saving.
export const getCopilotToken = async (
  githubToken?: string,
  signal?: AbortSignal,
) => {
  const authState = githubToken ? { ...state, githubToken } : state
  const response = await fetch(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(authState),
      signal,
    },
  )

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error(
      "Failed to get Copilot token response body",
      redactText(errorText),
    )

    throw new HTTPError(
      `Failed to get Copilot token (GitHub responded ${response.status})`,
      response,
    )
  }

  return (await response.json()) as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
export interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  // Per-SKU isolated endpoints returned by the token exchange. This is the
  // authoritative routing source for the issued token; `/copilot_internal/user`
  // may advertise a different segmented host (e.g. business vs enterprise).
  endpoints?: {
    api?: string
    proxy?: string
    telemetry?: string
  }
}
