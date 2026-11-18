/**
 * Errors of the ChatGPT web transport. Every failure is mapped to an
 * OpenAI-style error response so the existing provider pipeline forwards the
 * status and message to the client unchanged.
 */

const MAX_ERROR_BODY_CHARS = 4_000

export interface ChatGPTWebErrorOptions {
  cause?: unknown
  retryAfter?: string
  /** Sent as `x-should-retry`, e.g. `false` for limits that reset in hours. */
  shouldRetry?: boolean
}

export class ChatGPTWebError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter?: string
  readonly shouldRetry?: boolean

  constructor(
    status: number,
    code: string,
    message: string,
    options: ChatGPTWebErrorOptions = {},
  ) {
    super(message, { cause: options.cause })
    this.name = "ChatGPTWebError"
    this.status = status
    this.code = code
    this.retryAfter = options.retryAfter
    this.shouldRetry = options.shouldRetry
  }
}

function getErrorType(status: number): string {
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 500) return "api_error"
  return "invalid_request_error"
}

export function createChatGPTWebErrorBody(error: ChatGPTWebError): {
  error: { code: string; message: string; type: string }
} {
  return {
    error: {
      code: error.code,
      message: error.message,
      type: getErrorType(error.status),
    },
  }
}

export function createChatGPTWebErrorResponse(
  error: ChatGPTWebError,
): Response {
  const headers = new Headers({ "content-type": "application/json" })
  if (error.retryAfter) headers.set("retry-after", error.retryAfter)
  if (error.shouldRetry !== undefined) {
    headers.set("x-should-retry", String(error.shouldRetry))
  }
  return new Response(JSON.stringify(createChatGPTWebErrorBody(error)), {
    headers,
    status: error.status,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * ChatGPT reports failures as `{"detail": "..."}` or
 * `{"detail": {"message": "...", "code": "..."}}`; Cloudflare answers with an
 * HTML challenge page instead.
 */
export function parseChatGPTWebErrorDetail(body: string): {
  code?: string
  message?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const detail = parsed.detail ?? parsed.error
  if (typeof detail === "string" && detail.trim()) {
    return { message: detail.trim() }
  }
  if (!isRecord(detail)) return {}
  return {
    code:
      typeof detail.code === "string" && detail.code ? detail.code : undefined,
    message:
      typeof detail.message === "string" && detail.message.trim() ?
        detail.message.trim()
      : undefined,
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_CHARS)
  } catch {
    return ""
  }
}

/** Converts a non-2xx response of the ChatGPT web backend into an error. */
export async function createChatGPTWebUpstreamError(
  response: Response,
  operation: string,
): Promise<ChatGPTWebError> {
  const body = await readErrorBody(response)
  const detail = parseChatGPTWebErrorDetail(body)
  const status = response.status
  const suffix = detail.message ? `: ${detail.message}` : ""
  const retryAfter = response.headers.get("retry-after") ?? undefined

  if (response.headers.get("cf-mitigated") === "challenge") {
    return new ChatGPTWebError(
      403,
      "chatgpt_cloudflare_challenge",
      `ChatGPT ${operation} was blocked by a Cloudflare challenge (HTTP ${status}).`,
    )
  }
  if (status === 401) {
    return new ChatGPTWebError(
      401,
      detail.code ?? "chatgpt_unauthorized",
      `ChatGPT rejected the login for ${operation} (HTTP 401)${suffix}. Sign in at chatgpt.com again and update the cookie in the dashboard: Admin → Providers → chatgpt → Cookie.`,
    )
  }
  if (status === 429) {
    return new ChatGPTWebError(
      429,
      detail.code ?? "chatgpt_rate_limited",
      `ChatGPT rate limit reached for ${operation}${suffix}`,
      { retryAfter },
    )
  }
  if (status >= 500) {
    return new ChatGPTWebError(
      502,
      detail.code ?? "chatgpt_upstream_error",
      `ChatGPT ${operation} failed with HTTP ${status}${suffix}`,
    )
  }
  return new ChatGPTWebError(
    status,
    detail.code ?? "chatgpt_request_failed",
    `ChatGPT ${operation} failed with HTTP ${status}${suffix}`,
  )
}
