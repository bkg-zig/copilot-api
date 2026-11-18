import { afterEach, expect, mock, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getCopilotToken } from "~/services/github/get-copilot-token"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("returns the token envelope including per-SKU endpoints", async () => {
  state.githubToken = "github-token"

  const fetchMock = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          token: "copilot-token",
          expires_at: 1_800_000_000,
          refresh_in: 1_800,
          sku: "copilot_enterprise_seat_quota",
          endpoints: {
            api: "https://api.enterprise.githubcopilot.com",
            proxy: "proxy.enterprise.githubcopilot.com",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const result = await getCopilotToken()

  expect(result.token).toBe("copilot-token")
  expect(result.endpoints?.api).toBe("https://api.enterprise.githubcopilot.com")
  expect(result.endpoints?.proxy).toBe("proxy.enterprise.githubcopilot.com")
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.github.com/copilot_internal/v2/token",
    expect.any(Object),
  )
})

test("returns a token envelope without endpoints when absent", async () => {
  state.githubToken = "github-token"

  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          token: "copilot-token",
          expires_at: 1_800_000_000,
          refresh_in: 1_800,
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  const result = await getCopilotToken()

  expect(result.token).toBe("copilot-token")
  expect(result.endpoints).toBeUndefined()
})

test("checks another account's token without touching the running one", async () => {
  state.githubToken = "running-token"
  const controller = new AbortController()
  let init: RequestInit | undefined
  globalThis.fetch = mock((_url: string, requestInit?: RequestInit) => {
    init = requestInit
    return Promise.resolve(
      new Response(
        JSON.stringify({ token: "t", expires_at: 1, refresh_in: 1 }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch

  await getCopilotToken("new-account-token", controller.signal)

  const headers = init?.headers as Record<string, string>
  expect(headers.authorization ?? headers.Authorization).toContain(
    "new-account-token",
  )
  expect(init?.signal).toBe(controller.signal)
  expect(state.githubToken).toBe("running-token")
})

test("throws HTTPError when the token exchange fails", () => {
  state.githubToken = "github-token"

  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("unauthorized", { status: 401 })),
  ) as unknown as typeof fetch

  expect(getCopilotToken()).rejects.toBeInstanceOf(HTTPError)
})

test("includes the upstream status in the token exchange error", async () => {
  state.githubToken = "github-token"

  globalThis.fetch = mock(() =>
    Promise.resolve(new Response("unauthorized", { status: 401 })),
  ) as unknown as typeof fetch

  const error = await getCopilotToken().catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(HTTPError)
  expect((error as Error).message).toContain("401")
})
