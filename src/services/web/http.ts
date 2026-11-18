import { acquireWebSlot, setWebCooldown } from "./rate-limit"
import { WebSessionError } from "./types"

export const WEB_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

export interface WebHttpOptions {
  fetchFn?: typeof fetch
  signal?: AbortSignal
  label: string
  loginHint: string
}

/**
 * One upstream call with the web rate-limit gate. 401 becomes a session
 * error carrying the provider login hint; 429 sets the account cooldown and
 * surfaces as a rate error. Response bodies are never logged here.
 */
export async function webFetch(
  url: string,
  init: RequestInit,
  options: WebHttpOptions,
): Promise<Response> {
  await acquireWebSlot(options.label, options.signal)
  const fetchFn = options.fetchFn ?? fetch
  const response = await fetchFn(url, { ...init, signal: options.signal })
  if (response.status === 401 || response.status === 403) {
    throw new WebSessionError(
      401,
      "web_session_expired",
      options.loginHint,
      `Web session rejected (HTTP ${response.status}). ${options.loginHint}`,
    )
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"))
    setWebCooldown(
      options.label,
      Number.isFinite(retryAfter) && retryAfter > 0 ?
        retryAfter * 1000
      : 60_000,
    )
    throw new WebSessionError(
      429,
      "web_rate_limited",
      options.loginHint,
      "Web provider rate limit reached; the account is cooling down.",
    )
  }
  if (!response.ok) {
    throw new WebSessionError(
      502,
      "web_upstream_error",
      options.loginHint,
      `Web provider responded with HTTP ${response.status}.`,
    )
  }
  return response
}

export function cookieHeaderOf(input: {
  kind: string
  value?: string
}): string | undefined {
  if (!input.value) return undefined
  if (input.kind === "cookie") return input.value
  return undefined
}

export function bearerOf(input: {
  kind: string
  value?: string
}): string | undefined {
  if (!input.value) return undefined
  if (input.kind === "token") return input.value
  // A pasted cookie header can carry a token= cookie; adapters that accept
  // bearer auth extract it themselves.
  return undefined
}
