/** Shared fixtures for the ChatGPT web transport tests. */

export type FetchInput = string | URL | Request

export function requestUrlOf(input: FetchInput): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.toString() : input.url
}

/** Resolves with the rejection reason of `promise`, failing if it resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject")
}

export const webCatalogFixture = {
  categories: [
    {
      category: "auto",
      default_model: "auto",
      human_category_name: "Auto",
      supported_models: [],
    },
    {
      category: "gpt_6_reasoning_mini",
      default_model: "gpt-6-t-mini",
      human_category_name: "Thinking mini",
      supported_models: ["gpt-6-t-mini"],
    },
    {
      category: "gpt_5_auto",
      default_model: "gpt-6",
      human_category_name: "Instant",
      supported_models: ["gpt-6"],
    },
    { category: "broken" },
    "not a category",
  ],
  default_model_slug: "auto",
  models: [
    {
      max_tokens: 34834,
      reasoning_type: "auto",
      slug: "gpt-6",
      tags: [],
      title: "GPT-6",
    },
    {
      max_tokens: 262144,
      reasoning_type: "reasoning",
      slug: "gpt-6-t-mini",
      tags: ["history_off_approved"],
      title: "GPT-6",
    },
    {
      max_tokens: 34834,
      reasoning_type: "none",
      slug: "gpt-6-mini",
      title: "GPT-6",
    },
    {
      max_tokens: 34815,
      slug: "research",
      tags: ["gpt4"],
      title: "Deep Research",
    },
    {
      max_tokens: 262144,
      slug: "chatgpt_alpha_model_external_access_reserved_gate_13",
      tags: ["history_off_approved", "hidden"],
      title: "Alpha",
    },
    { max_tokens: 34834, reasoning_type: "auto", slug: "auto", title: "Auto" },
    { slug: "untitled" },
    { slug: "gpt-6" },
    { title: "missing slug" },
    null,
  ],
}

/** Unsigned JWT with the given claims, like ChatGPT's access tokens. */
export function createTestJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`
}

export const TEST_SESSION_COOKIE =
  "__Secure-next-auth.session-token=browser-session"

/** `/api/auth/session` answer of a signed-in ChatGPT web account. */
export function createSessionResponse(
  options: {
    accessToken?: string
    planType?: string
    setCookies?: Array<string>
  } = {},
): Response {
  const headers = new Headers({ "content-type": "application/json" })
  for (const cookie of options.setCookies ?? [
    "oai-did=device-from-server; Path=/; Max-Age=31104000",
    "__Secure-next-auth.session-token=rotated-session; Path=/; Secure; HttpOnly",
  ]) {
    headers.append("set-cookie", cookie)
  }
  return new Response(
    JSON.stringify({
      accessToken:
        options.accessToken
        ?? createTestJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      account: { id: "acct-web", planType: options.planType ?? "plus" },
      expires: "2027-02-12T00:00:00.000Z",
      user: { id: "user-1" },
    }),
    { headers },
  )
}

/** Serializes SSE `data:` payloads the way the ChatGPT backend sends them. */
export function sseBody(payloads: Array<unknown>): string {
  return payloads
    .map(
      (payload) =>
        `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`,
    )
    .join("")
}

/** Delta events of one visible assistant reply that streams `parts`. */
export function assistantReplyEvents(
  parts: Array<string>,
  options: { finishType?: string; messageId?: string } = {},
): Array<unknown> {
  const messageId = options.messageId ?? "answer-1"
  return [
    '"v1"',
    {
      o: "add",
      p: "",
      v: {
        conversation_id: "conv-1",
        error: null,
        message: {
          author: { role: "assistant" },
          content: { content_type: "text", parts: [""] },
          id: messageId,
          metadata: { model_slug: "gpt-6" },
          status: "in_progress",
        },
      },
    },
    ...parts.map((part) => ({
      o: "append",
      p: "/message/content/parts/0",
      v: part,
    })),
    {
      o: "patch",
      p: "",
      v: [
        { o: "replace", p: "/message/status", v: "finished_successfully" },
        { o: "replace", p: "/message/end_turn", v: true },
        {
          o: "append",
          p: "/message/metadata",
          v: { finish_details: { type: options.finishType ?? "stop" } },
        },
      ],
    },
    { conversation_id: "conv-1", type: "message_stream_complete" },
    "[DONE]",
  ]
}

export interface RecordedRequest {
  body: string
  headers: Headers
  method: string
  url: string
}

export interface ChatGPTWebFetchMockOptions {
  catalog?: unknown
  /** Response for `/conversation`; defaults to a short text reply. */
  conversation?: () => Response
  persona?: string
  requirements?: () => Response
  /** Response for `/api/auth/session`; defaults to a signed-in account. */
  session?: () => Response
}

export function createChatGPTWebFetchMock(
  options: ChatGPTWebFetchMockOptions = {},
): { fetch: typeof fetch; requests: Array<RecordedRequest> } {
  const requests: Array<RecordedRequest> = []
  const respond = (url: string): Response => {
    if (url.endsWith("/api/auth/session")) {
      return options.session?.() ?? createSessionResponse()
    }
    if (url.endsWith("/models")) {
      return Response.json(options.catalog ?? webCatalogFixture)
    }
    if (url.endsWith("/sentinel/chat-requirements")) {
      return (
        options.requirements?.()
        ?? Response.json({
          persona: options.persona ?? "chatgpt-freeaccount",
          proofofwork: { difficulty: "0fff", required: true, seed: "seed" },
          token: "requirements-token",
        })
      )
    }
    if (url.endsWith("/conversation")) {
      return (
        options.conversation?.()
        ?? new Response(sseBody(assistantReplyEvents(["Hello", " world"])), {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        })
      )
    }
    return new Response("not found", { status: 404 })
  }
  const fetchImpl = ((input: FetchInput, init?: RequestInit) => {
    const url = requestUrlOf(input)
    requests.push({
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      url,
    })
    return Promise.resolve(respond(url))
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}
