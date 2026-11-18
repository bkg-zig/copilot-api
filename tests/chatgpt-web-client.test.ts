import { describe, expect, test } from "bun:test"

import { ChatGPTCookieJar } from "~/services/chatgpt/cookie-session"
import {
  ChatGPTWebError,
  createChatGPTWebErrorBody,
  createChatGPTWebErrorResponse,
  createChatGPTWebUpstreamError,
  parseChatGPTWebErrorDetail,
} from "~/services/chatgpt/errors"
import {
  createProofFingerprint,
  createRequirementsProof,
  createSentinelHeaders,
  fetchChatRequirements,
  isProofAccepted,
  parseChatRequirements,
  solveProofOfWork,
} from "~/services/chatgpt/sentinel"
import {
  buildChatGPTWebHeaders,
  CHATGPT_WEB_USER_AGENT,
  createChatGPTWebSignal,
  normalizeChatGPTBackendUrl,
  resolveChatGPTWebSession,
  resolveChatGPTWebUrl,
} from "~/services/chatgpt/web-client"

import {
  type FetchInput,
  rejectionOf,
  requestUrlOf,
} from "./fixtures/chatgpt-web"

function session(apiKey = "access-token") {
  return resolveChatGPTWebSession({
    apiKey,
    baseUrl: "https://chatgpt.example",
  })
}

describe("chatgpt web client", () => {
  test("normalizes backend URLs", () => {
    expect(normalizeChatGPTBackendUrl(undefined)).toBe(
      "https://chatgpt.com/backend-api",
    )
    expect(
      normalizeChatGPTBackendUrl(" https://chatgpt.com/backend-api/ "),
    ).toBe("https://chatgpt.com/backend-api")
    expect(normalizeChatGPTBackendUrl("https://proxy.example")).toBe(
      "https://proxy.example/backend-api",
    )
  })

  test("uses a configured access token with a stable device id", async () => {
    const first = await session()
    const second = await session()
    expect(first).toMatchObject({
      accessToken: "access-token",
      backendUrl: "https://chatgpt.example/backend-api",
      origin: "https://chatgpt.example",
    })
    expect(first.accountId).toBeUndefined()
    expect(first.identityKey).toMatch(/^token:[0-9a-f]{24}$/u)
    expect(first.identityKey).not.toContain("access-token")
    expect(second.deviceId).toBe(first.deviceId)
    expect((await session("other-token")).deviceId).not.toBe(first.deviceId)
  })

  test("evicts the oldest device id beyond the bound", async () => {
    const original = (await session("evict-0")).deviceId
    for (let index = 1; index <= 40; index++) {
      await session(`evict-${index}`)
    }
    expect((await session("evict-0")).deviceId).not.toBe(original)
  })

  test("requires a ChatGPT web login instead of falling back to Codex", async () => {
    const error = await rejectionOf(
      resolveChatGPTWebSession({ apiKey: "  ", baseUrl: "", cookie: " " }),
    )
    expect(error).toBeInstanceOf(ChatGPTWebError)
    expect(error).toMatchObject({ code: "chatgpt_login_required", status: 401 })
    expect((error as Error).message).toContain(
      "Admin → Providers → chatgpt → Cookie",
    )
  })

  test("builds browser-like headers", async () => {
    const current = await session()
    const headers = buildChatGPTWebHeaders(current, "/conversation", {
      accept: "text/event-stream",
      "x-empty": undefined,
    })
    expect(headers.get("authorization")).toBe("Bearer access-token")
    expect(headers.get("chatgpt-account-id")).toBeNull()
    expect(headers.get("cookie")).toBeNull()
    expect(headers.get("accept")).toBe("text/event-stream")
    expect(headers.get("x-empty")).toBeNull()
    expect(headers.get("user-agent")).toBe(CHATGPT_WEB_USER_AGENT)
    expect(headers.get("origin")).toBe("https://chatgpt.example")
    expect(headers.get("x-openai-target-path")).toBe(
      "/backend-api/conversation",
    )
    expect(resolveChatGPTWebUrl(current, "/models")).toBe(
      "https://chatgpt.example/backend-api/models",
    )

    const withLogin = buildChatGPTWebHeaders(
      {
        ...current,
        accountId: "acct-1",
        cookieJar: new ChatGPTCookieJar(new Map([["a", "1"]])),
      },
      "/models",
    )
    expect(withLogin.get("chatgpt-account-id")).toBe("acct-1")
    expect(withLogin.get("cookie")).toBe("a=1")
  })

  test("combines client and timeout signals", () => {
    const client = new AbortController()
    const signal = createChatGPTWebSignal(60_000, client.signal)
    expect(signal.aborted).toBe(false)
    client.abort()
    expect(signal.aborted).toBe(true)
    expect(createChatGPTWebSignal(60_000).aborted).toBe(false)
  })
})

describe("chatgpt web errors", () => {
  test("maps statuses to OpenAI error types", async () => {
    const cases: Array<[number, string]> = [
      [400, "invalid_request_error"],
      [401, "authentication_error"],
      [403, "permission_error"],
      [429, "rate_limit_error"],
      [502, "api_error"],
    ]
    for (const [status, type] of cases) {
      expect(
        createChatGPTWebErrorBody(new ChatGPTWebError(status, "c", "m")).error
          .type,
      ).toBe(type)
    }
    const response = createChatGPTWebErrorResponse(
      new ChatGPTWebError(429, "limited", "slow down", { retryAfter: "30" }),
    )
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("30")
    expect(response.headers.get("x-should-retry")).toBeNull()
    expect(
      createChatGPTWebErrorResponse(
        new ChatGPTWebError(429, "limit", "later", { shouldRetry: false }),
      ).headers.get("x-should-retry"),
    ).toBe("false")
    expect(await response.json()).toEqual({
      error: {
        code: "limited",
        message: "slow down",
        type: "rate_limit_error",
      },
    })
  })

  test("parses ChatGPT error details", () => {
    expect(parseChatGPTWebErrorDetail('{"detail":" nope "}')).toEqual({
      message: "nope",
    })
    expect(
      parseChatGPTWebErrorDetail(
        '{"detail":{"message":"too long","code":"message_length_exceeds_limit"}}',
      ),
    ).toEqual({ code: "message_length_exceeds_limit", message: "too long" })
    expect(parseChatGPTWebErrorDetail('{"error":"bad"}')).toEqual({
      message: "bad",
    })
    expect(parseChatGPTWebErrorDetail('{"detail":{}}')).toEqual({
      code: undefined,
      message: undefined,
    })
    expect(parseChatGPTWebErrorDetail("<html>")).toEqual({})
    expect(parseChatGPTWebErrorDetail("[1]")).toEqual({})
    expect(parseChatGPTWebErrorDetail('{"detail":5}')).toEqual({})
  })

  test("converts upstream responses into errors", async () => {
    const challenge = await createChatGPTWebUpstreamError(
      new Response("<html>", {
        headers: { "cf-mitigated": "challenge" },
        status: 403,
      }),
      "conversation",
    )
    expect(challenge).toMatchObject({
      code: "chatgpt_cloudflare_challenge",
      status: 403,
    })

    const unauthorized = await createChatGPTWebUpstreamError(
      Response.json({ detail: "expired" }, { status: 401 }),
      "conversation",
    )
    expect(unauthorized).toMatchObject({
      code: "chatgpt_unauthorized",
      status: 401,
    })
    expect(unauthorized.message).toContain("expired")

    const limited = await createChatGPTWebUpstreamError(
      Response.json(
        { detail: { code: "rate_limit", message: "wait" } },
        { headers: { "retry-after": "12" }, status: 429 },
      ),
      "conversation",
    )
    expect(limited).toMatchObject({
      code: "rate_limit",
      retryAfter: "12",
      status: 429,
    })

    const server = await createChatGPTWebUpstreamError(
      new Response("oops", { status: 503 }),
      "conversation",
    )
    expect(server).toMatchObject({
      code: "chatgpt_upstream_error",
      status: 502,
    })

    const other = await createChatGPTWebUpstreamError(
      Response.json({ detail: "bad model" }, { status: 404 }),
      "model catalog",
    )
    expect(other).toMatchObject({ code: "chatgpt_request_failed", status: 404 })
    expect(other.message).toBe(
      "ChatGPT model catalog failed with HTTP 404: bad model",
    )
  })
})

describe("chatgpt sentinel", () => {
  test("creates an 18 field fingerprint", () => {
    const fingerprint = createProofFingerprint("agent")
    expect(fingerprint).toHaveLength(18)
    expect(fingerprint[3]).toBe(0)
    expect(fingerprint[4]).toBe("agent")
    expect(fingerprint[9]).toBe(0)
  })

  test("solves and verifies proofs of work", async () => {
    const proof = await solveProofOfWork("seed", "0fff")
    expect(isProofAccepted("seed", proof, "0fff")).toBe(true)
    const decoded = JSON.parse(
      Buffer.from(proof, "base64").toString(),
    ) as Array<unknown>
    expect(decoded).toHaveLength(18)
    expect(decoded[9]).toBe(Math.floor(Number(decoded[3]) / 2))

    const requirementsProof = await createRequirementsProof()
    expect(requirementsProof.startsWith("gAAAAAC")).toBe(true)
  })

  test("rejects invalid or unsolved difficulties", async () => {
    expect(await rejectionOf(solveProofOfWork("seed", "zz"))).toMatchObject({
      code: "chatgpt_sentinel_invalid",
    })
    expect(
      await rejectionOf(
        solveProofOfWork("seed", "000000000000", { maxAttempts: 10 }),
      ),
    ).toMatchObject({ code: "chatgpt_sentinel_unsolved" })
  })

  test("honours aborts during long searches", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await rejectionOf(
      solveProofOfWork("seed", "000000000000", {
        maxAttempts: 10_000,
        signal: controller.signal,
      }),
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe("AbortError")
  })

  test("parses chat requirements", () => {
    expect(
      parseChatRequirements({
        arkose: { required: false },
        persona: "chatgpt-freeaccount",
        proofofwork: { difficulty: "0fffff", required: true, seed: "0.5" },
        token: "req-token",
        turnstile: { required: true },
      }),
    ).toEqual({
      arkoseRequired: false,
      persona: "chatgpt-freeaccount",
      proofOfWork: { difficulty: "0fffff", seed: "0.5" },
      token: "req-token",
      turnstileRequired: true,
    })
    expect(
      parseChatRequirements({ token: "t", proofofwork: { required: false } }),
    ).toEqual({
      arkoseRequired: false,
      persona: undefined,
      proofOfWork: undefined,
      token: "t",
      turnstileRequired: false,
    })
    expect(() => parseChatRequirements(null)).toThrow(ChatGPTWebError)
  })

  test("fetches requirements and answers the challenge", async () => {
    const requests: Array<{ body: string; headers: Headers; url: string }> = []
    const fetchImpl = ((input: FetchInput, init?: RequestInit) => {
      requests.push({
        body: typeof init?.body === "string" ? init.body : "",
        headers: new Headers(init?.headers),
        url: requestUrlOf(input),
      })
      return Promise.resolve(
        Response.json({
          persona: "chatgpt-freeaccount",
          proofofwork: { difficulty: "0fff", required: true, seed: "abc" },
          token: "req-token",
        }),
      )
    }) as typeof fetch

    const requirements = await fetchChatRequirements(await session(), {
      fetch: fetchImpl,
    })
    expect(requests[0]?.url).toBe(
      "https://chatgpt.example/backend-api/sentinel/chat-requirements",
    )
    const body = JSON.parse(requests[0]?.body ?? "{}") as { p: string }
    expect(body.p.startsWith("gAAAAAC")).toBe(true)
    expect(requests[0]?.headers.get("content-type")).toBe("application/json")

    const headers = await createSentinelHeaders(requirements)
    expect(headers["openai-sentinel-chat-requirements-token"]).toBe("req-token")
    const answer = headers["openai-sentinel-proof-token"] ?? ""
    expect(answer.startsWith("gAAAAAB")).toBe(true)
    expect(isProofAccepted("abc", answer.slice(7), "0fff")).toBe(true)

    expect(
      await createSentinelHeaders({
        arkoseRequired: false,
        token: "plain",
        turnstileRequired: false,
      }),
    ).toEqual({ "openai-sentinel-chat-requirements-token": "plain" })
  })

  test("rejects failed and Arkose-gated requirements", async () => {
    const failing = (() =>
      Promise.resolve(
        Response.json({ detail: "expired" }, { status: 401 }),
      )) as unknown as typeof fetch
    expect(
      await rejectionOf(
        fetchChatRequirements(await session(), { fetch: failing }),
      ),
    ).toMatchObject({ code: "chatgpt_unauthorized" })

    const arkose = (() =>
      Promise.resolve(
        Response.json({ arkose: { required: true }, token: "t" }),
      )) as unknown as typeof fetch
    expect(
      await rejectionOf(
        fetchChatRequirements(await session(), { fetch: arkose }),
      ),
    ).toMatchObject({ code: "chatgpt_arkose_required", status: 403 })
  })
})
