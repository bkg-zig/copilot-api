import { afterEach, describe, expect, mock, test } from "bun:test"

import { parseFetchCapture, toSessionInput } from "~/services/web/fetch-capture"
import { getWebAdapter, listWebAdapters } from "~/services/web/registry"
import { WebSessionError } from "~/services/web/types"
import { encodeDeepSeekPow, solveDeepSeekPow } from "~/services/web/deepseek"
import { resetWebRateLimits } from "~/services/web/rate-limit"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetWebRateLimits()
})

function sseResponse(frames: Array<string>): Response {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

describe("web adapter registry", () => {
  test("registers all planned adapters", () => {
    const ids = listWebAdapters().map((a) => a.id)
    expect(ids).toContain("chatgpt")
    expect(ids).toContain("claude-web")
    expect(ids).toContain("deepseek-web")
    expect(ids).toContain("qwen-web")
    expect(ids).toContain("gemini-web")
    expect(ids).toContain("grok-web")
    expect(ids).toContain("inception-web")
    expect(getWebAdapter("unknown")).toBeNull()
  })
})

describe("fetch capture parsing", () => {
  test("extracts cookie session and reports names only", () => {
    const parsed = parseFetchCapture(
      `fetch("https://claude.ai/api/organizations/x/chat_conversations/y/completion", {headers: {"cookie": "sessionKey=abc123; lastActiveOrg=123e4567-e89b-12d3-a456-426614174000", "accept": "text/event-stream"}})`,
    )
    expect(parsed.url).toContain("claude.ai")
    expect(parsed.cookieNames).toContain("sessionKey")
    expect(parsed.input).toEqual({
      kind: "cookie",
      value:
        "sessionKey=abc123; lastActiveOrg=123e4567-e89b-12d3-a456-426614174000",
    })
  })

  test("rejects text that is not a fetch call", () => {
    expect(() => parseFetchCapture("just some text")).toThrow()
    expect(toSessionInput("cookie", "a=b").kind).toBe("cookie")
  })
})

describe("claude adapter", () => {
  test("streams text deltas as chat completion chunks", async () => {
    const adapter = getWebAdapter("claude-web")!
    globalThis.fetch = mock((url: string) => {
      if (String(url).includes("/completion")) {
        return Promise.resolve(
          sseResponse([
            JSON.stringify({ type: "message_start", message: {} }),
            JSON.stringify({
              type: "content_block_delta",
              delta: { type: "text_delta", text: "OK" },
            }),
            JSON.stringify({ type: "message_stop" }),
            "[DONE]",
          ]),
        )
      }
      return Promise.resolve(
        Response.json([{ uuid: "123e4567-e89b-12d3-a456-426614174000" }]),
      )
    }) as unknown as typeof fetch

    const response = await adapter.chatCompletion(
      {
        name: "claude-web",
        type: "web",
        webAdapter: "claude-web",
        baseUrl: "",
        apiKey: "",
        authType: "cookie",
        cookie: "sessionKey=test",
      } as never,
      {
        model: "claude-web/claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hallo" }],
        stream: false,
      } as never,
      {},
    )
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0].message.content).toBe("OK")
  })

  test("rejects a missing session with the login hint", async () => {
    const adapter = getWebAdapter("claude-web")!
    const error = await adapter
      .validateSession({ kind: "none" })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WebSessionError)
    expect((error as WebSessionError).code).toContain("login")
    expect((error as WebSessionError).loginHint).toContain("claude.ai")
  })
})

describe("inception adapter", () => {
  test("mints a token and streams text deltas without any account", async () => {
    const adapter = getWebAdapter("inception-web")!
    globalThis.fetch = mock((url: string) => {
      if (String(url).endsWith("/api/session")) {
        return Promise.resolve(Response.json({ token: "tok-1" }))
      }
      return Promise.resolve(
        sseResponse([
          JSON.stringify({ type: "text-delta", delta: "OK" }),
          "[DONE]",
        ]),
      )
    }) as unknown as typeof fetch

    const status = await adapter.validateSession({ kind: "none" })
    expect(status.modelCount).toBeGreaterThan(0)
    const response = await adapter.chatCompletion(
      {
        name: "inception-web",
        type: "web",
        webAdapter: "inception-web",
        baseUrl: "",
        apiKey: "",
        authType: "cookie",
      } as never,
      {
        model: "mercury",
        messages: [{ role: "user", content: "Hallo" }],
        stream: false,
      } as never,
      {},
    )
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    expect(body.choices[0].message.content).toBe("OK")
  })
})

describe("deepseek pow", () => {
  test("solver finds a nonce satisfying its own construction and encodes it", () => {
    const challenge = {
      algorithm: "DeepSeekHashV1",
      challenge: "a1b2c3d4e5f6a1b2",
      salt: "testsalt",
      difficulty: 16,
      expire_at: 1893456000,
      signature: "sig",
      target_path: "/api/v0/chat/completion",
    }
    const answer = solveDeepSeekPow(challenge, 2_000_000)
    if (answer === null) throw new Error("POW solver returned null")
    const decoded = JSON.parse(
      Buffer.from(encodeDeepSeekPow(challenge, answer), "base64").toString(),
    ) as { answer: number; algorithm: string }
    expect(decoded.answer).toBe(answer)
    expect(decoded.algorithm).toBe("DeepSeekHashV1")
  })
})
