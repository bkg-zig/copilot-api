import { afterEach, describe, expect, test } from "bun:test"

import {
  CHATGPT_SESSION_COOKIE,
  ChatGPTCookieJar,
  clearChatGPTCookieLogins,
  forgetChatGPTCookieLogin,
  getChatGPTCookieLogin,
  parseChatGPTCookieInput,
  readJwtExpiry,
} from "~/services/chatgpt/cookie-session"
import {
  clearChatGPTWebCatalogCache,
  getChatGPTWebModels,
} from "~/services/chatgpt/models"
import {
  buildChatGPTWebHeaders,
  rememberChatGPTWebCookies,
  resolveChatGPTWebSession,
} from "~/services/chatgpt/web-client"

import {
  createSessionResponse,
  createTestJwt,
  type FetchInput,
  rejectionOf,
  requestUrlOf,
  TEST_SESSION_COOKIE,
  webCatalogFixture,
} from "./fixtures/chatgpt-web"

const ORIGIN = "https://chatgpt.example"
const USER_AGENT = "test-agent"

interface SessionRequest {
  cookie: string | null
  url: string
  userAgent: string | null
}

function sessionFetch(
  respond: () => Response,
  requests: Array<SessionRequest> = [],
): typeof fetch {
  return ((input: FetchInput, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    requests.push({
      cookie: headers.get("cookie"),
      url: requestUrlOf(input),
      userAgent: headers.get("user-agent"),
    })
    return Promise.resolve(respond())
  }) as typeof fetch
}

function login(cookie: string, fetchImpl: typeof fetch, now?: () => number) {
  return getChatGPTCookieLogin(cookie, {
    fetch: fetchImpl,
    now,
    origin: ORIGIN,
    userAgent: USER_AGENT,
  })
}

afterEach(() => {
  clearChatGPTCookieLogins()
  clearChatGPTWebCatalogCache()
})

describe("parseChatGPTCookieInput", () => {
  test("reads a Cookie header and drops browser-bound Cloudflare cookies", () => {
    const cookies = parseChatGPTCookieInput(
      `Cookie: ${CHATGPT_SESSION_COOKIE}=abc.def; oai-did=dev-1;\n cf_clearance=x; __cf_bm=y; _cfuvid=z; __cflb=w; cf_chl_rc_m=v; bad name=1; empty=; spaced=a b; =novalue`,
    )
    expect([...cookies]).toEqual([
      [CHATGPT_SESSION_COOKIE, "abc.def"],
      ["oai-did", "dev-1"],
    ])
  })

  test("accepts the bare value of the session token", () => {
    expect([...parseChatGPTCookieInput("  eyJhbGciOiJkaXIi..abc  ")]).toEqual([
      [CHATGPT_SESSION_COOKIE, "eyJhbGciOiJkaXIi..abc"],
    ])
    expect(parseChatGPTCookieInput("not a token").size).toBe(0)
  })

  test("reads JSON exports of cookie editor extensions", () => {
    const exported = JSON.stringify([
      {
        domain: ".chatgpt.com",
        name: `${CHATGPT_SESSION_COOKIE}.0`,
        value: "part1",
      },
      {
        domain: "chatgpt.com",
        name: `${CHATGPT_SESSION_COOKIE}.1`,
        value: "part2",
      },
      { domain: ".example.com", name: "other", value: "skip" },
      { name: "_account", value: "personal" },
      "ignored",
    ])
    expect([...parseChatGPTCookieInput(exported)]).toEqual([
      [`${CHATGPT_SESSION_COOKIE}.0`, "part1"],
      [`${CHATGPT_SESSION_COOKIE}.1`, "part2"],
      ["_account", "personal"],
    ])
    expect([
      ...parseChatGPTCookieInput('{"oai-did": "dev", "count": 5}'),
    ]).toEqual([["oai-did", "dev"]])
    expect(parseChatGPTCookieInput("{broken").size).toBe(0)
  })
})

describe("ChatGPTCookieJar", () => {
  test("applies Set-Cookie headers like a browser", () => {
    const jar = new ChatGPTCookieJar(
      new Map([
        ["keep", "1"],
        ["gone", "2"],
        ["old", "3"],
        ["blank", "4"],
      ]),
    )
    const headers = new Headers()
    for (const line of [
      "fresh=5; Path=/; Secure",
      "keep=6",
      "gone=x; Max-Age=0",
      "old=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "blank=; Path=/",
      "future=7; Expires=Fri, 01 Jan 2100 00:00:00 GMT; HttpOnly",
      "novalue",
      "bad name=8",
    ]) {
      headers.append("set-cookie", line)
    }
    jar.absorb(headers, Date.parse("2026-11-14T00:00:00Z"))
    expect(jar.header()).toBe("keep=6; fresh=5; future=7")
    expect(jar.get("keep")).toBe("6")
    expect(jar.size).toBe(3)
  })

  test("bounds the number of cookies", () => {
    const jar = new ChatGPTCookieJar()
    const headers = new Headers()
    for (let index = 0; index < 70; index++) {
      headers.append("set-cookie", `c${index}=v`)
    }
    jar.absorb(headers)
    expect(jar.size).toBe(64)
    jar.absorb(new Headers({ "set-cookie": "c0=updated" }))
    expect(jar.get("c0")).toBe("updated")
  })
})

test("reads the expiry of access tokens", () => {
  expect(readJwtExpiry(createTestJwt({ exp: 1_800_000_000 }))).toBe(
    1_800_000_000_000,
  )
  expect(readJwtExpiry(createTestJwt({ sub: "user" }))).toBeUndefined()
  expect(readJwtExpiry("opaque")).toBeUndefined()
  expect(readJwtExpiry("a.!!!.c")).toBeUndefined()
})

describe("getChatGPTCookieLogin", () => {
  test("exchanges the session cookie once and keeps the cookies the server sets", async () => {
    const requests: Array<SessionRequest> = []
    const fetchImpl = sessionFetch(() => createSessionResponse(), requests)
    const cookie = `${TEST_SESSION_COOKIE}; cf_clearance=browser`
    const first = await login(cookie, fetchImpl)
    const second = await login(cookie, fetchImpl)
    expect(second).toBe(first)
    expect(requests).toEqual([
      {
        cookie: TEST_SESSION_COOKIE,
        url: `${ORIGIN}/api/auth/session`,
        userAgent: USER_AGENT,
      },
    ])
    expect(first).toMatchObject({ accountId: "acct-web", planType: "plus" })
    expect(first.identityKey).toMatch(/^cookie:[0-9a-f]{24}$/u)
    expect(first.jar.get("oai-did")).toBe("device-from-server")
    expect(first.jar.get(CHATGPT_SESSION_COOKIE)).toBe("rotated-session")
  })

  test("deduplicates concurrent exchanges", async () => {
    const requests: Array<SessionRequest> = []
    const fetchImpl = sessionFetch(() => createSessionResponse(), requests)
    const [first, second] = await Promise.all([
      login(TEST_SESSION_COOKIE, fetchImpl),
      login(TEST_SESSION_COOKIE, fetchImpl),
    ])
    expect(second).toBe(first)
    expect(requests).toHaveLength(1)
  })

  test("refreshes before the token expires, at least hourly, and sends the rotated cookie", async () => {
    let now = Date.parse("2026-11-14T12:00:00Z")
    const clock = () => now
    const shortLived: Array<SessionRequest> = []
    const exp = Math.floor(now / 1000) + 30 * 60
    const shortFetch = sessionFetch(
      () => createSessionResponse({ accessToken: createTestJwt({ exp }) }),
      shortLived,
    )
    await login(TEST_SESSION_COOKIE, shortFetch, clock)
    now += 24 * 60_000
    await login(TEST_SESSION_COOKIE, shortFetch, clock)
    expect(shortLived).toHaveLength(1)
    now += 2 * 60_000
    await login(TEST_SESSION_COOKIE, shortFetch, clock)
    expect(shortLived).toHaveLength(2)
    expect(shortLived[1]?.cookie).toBe(
      `${CHATGPT_SESSION_COOKIE}=rotated-session; oai-did=device-from-server`,
    )

    const longLived: Array<SessionRequest> = []
    const longExp = Math.floor(now / 1000) + 10 * 86_400
    const longFetch = sessionFetch(
      () =>
        createSessionResponse({ accessToken: createTestJwt({ exp: longExp }) }),
      longLived,
    )
    const longCookie = `${CHATGPT_SESSION_COOKIE}=long-session`
    await login(longCookie, longFetch, clock)
    now += 59 * 60_000
    await login(longCookie, longFetch, clock)
    expect(longLived).toHaveLength(1)
    now += 2 * 60_000
    await login(longCookie, longFetch, clock)
    expect(longLived).toHaveLength(2)

    const opaque: Array<SessionRequest> = []
    const opaqueFetch = sessionFetch(
      () => createSessionResponse({ accessToken: "opaque-token" }),
      opaque,
    )
    const opaqueCookie = `${CHATGPT_SESSION_COOKIE}=opaque-session`
    await login(opaqueCookie, opaqueFetch, clock)
    now += 4 * 60_000
    await login(opaqueCookie, opaqueFetch, clock)
    expect(opaque).toHaveLength(1)
    now += 2 * 60_000
    await login(opaqueCookie, opaqueFetch, clock)
    expect(opaque).toHaveLength(2)
  })

  test("accepts a session token split into chunks", async () => {
    const requests: Array<SessionRequest> = []
    const fetchImpl = sessionFetch(() => createSessionResponse(), requests)
    const chunkedCookie = `${CHATGPT_SESSION_COOKIE}.0=part1; ${CHATGPT_SESSION_COOKIE}.1=part2`
    const chunked = await login(chunkedCookie, fetchImpl)
    expect(requests[0]?.cookie).toBe(chunkedCookie)
    const whole = await login(`${CHATGPT_SESSION_COOKIE}=part1part2`, fetchImpl)
    expect(whole.identityKey).toBe(chunked.identityKey)
  })

  test("rejects cookies without a session token and expired logins", async () => {
    const requests: Array<SessionRequest> = []
    const fetchImpl = sessionFetch(() => Response.json({}), requests)
    expect(
      await rejectionOf(login("oai-did=only-device", fetchImpl)),
    ).toMatchObject({ code: "chatgpt_cookie_invalid", status: 401 })
    expect(requests).toHaveLength(0)

    const expired = await rejectionOf(login(TEST_SESSION_COOKIE, fetchImpl))
    expect(expired).toMatchObject({
      code: "chatgpt_login_expired",
      status: 401,
    })
    expect((expired as Error).message).toContain(
      "Admin → Providers → chatgpt → Cookie",
    )

    const notJson = sessionFetch(
      () =>
        new Response("<html>", { headers: { "content-type": "text/html" } }),
    )
    expect(
      await rejectionOf(
        login(`${CHATGPT_SESSION_COOKIE}=html-session`, notJson),
      ),
    ).toMatchObject({ code: "chatgpt_login_expired" })
  })

  test("does not resend a rejected cookie for a minute", async () => {
    let now = Date.parse("2026-11-14T12:00:00Z")
    const clock = () => now
    const requests: Array<SessionRequest> = []
    let respond = () => Response.json({})
    const fetchImpl = sessionFetch(() => respond(), requests)
    const first = await rejectionOf(
      login(TEST_SESSION_COOKIE, fetchImpl, clock),
    )
    now += 30_000
    expect(
      await rejectionOf(login(TEST_SESSION_COOKIE, fetchImpl, clock)),
    ).toBe(first)
    expect(requests).toHaveLength(1)

    now += 31_000
    respond = () => createSessionResponse()
    expect((await login(TEST_SESSION_COOKIE, fetchImpl, clock)).accountId).toBe(
      "acct-web",
    )
    expect(requests).toHaveLength(2)

    // Transient failures are retried right away.
    respond = () => new Response("down", { status: 503 })
    const flaky = `${CHATGPT_SESSION_COOKIE}=flaky-session`
    await rejectionOf(login(flaky, fetchImpl, clock))
    expect(await rejectionOf(login(flaky, fetchImpl, clock))).toMatchObject({
      code: "chatgpt_upstream_error",
      status: 502,
    })
    expect(requests).toHaveLength(4)
  })

  test("maps failed session requests", async () => {
    const challenged = sessionFetch(
      () =>
        new Response("<html>", {
          headers: { "cf-mitigated": "challenge" },
          status: 403,
        }),
    )
    expect(
      await rejectionOf(login(TEST_SESSION_COOKIE, challenged)),
    ).toMatchObject({ code: "chatgpt_cloudflare_challenge", status: 403 })
  })

  test("re-exchanges forgotten logins and evicts the oldest login", async () => {
    const requests: Array<SessionRequest> = []
    const fetchImpl = sessionFetch(() => createSessionResponse(), requests)
    const first = await login(TEST_SESSION_COOKIE, fetchImpl)
    forgetChatGPTCookieLogin(first.identityKey)
    forgetChatGPTCookieLogin("cookie:unknown")
    await login(TEST_SESSION_COOKIE, fetchImpl)
    expect(requests).toHaveLength(2)

    for (let index = 0; index < 16; index++) {
      await login(`${CHATGPT_SESSION_COOKIE}=session-${index}`, fetchImpl)
    }
    await login(TEST_SESSION_COOKIE, fetchImpl)
    expect(requests).toHaveLength(2 + 16 + 1)
  })
})

describe("chatgpt web sessions of a cookie login", () => {
  test("signs in with the cookie and sends it with every request", async () => {
    const session = await resolveChatGPTWebSession(
      {
        apiKey: "ignored-token",
        baseUrl: `${ORIGIN}/backend-api`,
        cookie: TEST_SESSION_COOKIE,
      },
      { fetch: sessionFetch(() => createSessionResponse()) },
    )
    expect(session).toMatchObject({
      accountId: "acct-web",
      deviceId: "device-from-server",
      origin: ORIGIN,
    })
    expect(session.accessToken).not.toBe("ignored-token")
    const headers = buildChatGPTWebHeaders(session, "/models")
    expect(headers.get("authorization")).toBe(`Bearer ${session.accessToken}`)
    expect(headers.get("chatgpt-account-id")).toBe("acct-web")
    expect(headers.get("cookie")).toBe(
      `${CHATGPT_SESSION_COOKIE}=rotated-session; oai-did=device-from-server`,
    )

    rememberChatGPTWebCookies(
      session,
      new Response(null, {
        headers: { "set-cookie": "__cf_bm=server; Path=/" },
      }),
    )
    expect(buildChatGPTWebHeaders(session, "/models").get("cookie")).toContain(
      "__cf_bm=server",
    )
  })

  test("uses a stable device id when the server sets none", async () => {
    const fetchImpl = sessionFetch(() =>
      createSessionResponse({ setCookies: [] }),
    )
    const credentials = { apiKey: "", baseUrl: "", cookie: TEST_SESSION_COOKIE }
    const first = await resolveChatGPTWebSession(credentials, {
      fetch: fetchImpl,
    })
    const second = await resolveChatGPTWebSession(credentials, {
      fetch: fetchImpl,
    })
    expect(first.origin).toBe("https://chatgpt.com")
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(second.deviceId).toBe(first.deviceId)
  })

  test("signs in again after the backend rejected the access token", async () => {
    const paths: Array<string> = []
    let catalogStatus = 401
    const fetchImpl = ((input: FetchInput) => {
      const url = requestUrlOf(input)
      paths.push(new URL(url).pathname)
      if (url.endsWith("/api/auth/session")) {
        return Promise.resolve(createSessionResponse())
      }
      return Promise.resolve(
        catalogStatus === 401 ?
          Response.json({ detail: "token revoked" }, { status: 401 })
        : Response.json(webCatalogFixture),
      )
    }) as typeof fetch
    const credentials = {
      apiKey: "",
      baseUrl: `${ORIGIN}/backend-api`,
      cookie: TEST_SESSION_COOKIE,
    }
    expect(
      await rejectionOf(getChatGPTWebModels(credentials, { fetch: fetchImpl })),
    ).toMatchObject({ code: "chatgpt_unauthorized", status: 401 })
    catalogStatus = 200
    const models = await getChatGPTWebModels(credentials, { fetch: fetchImpl })
    expect(models.map((model) => model.id)).toContain("gpt-6")
    expect(paths).toEqual([
      "/api/auth/session",
      "/backend-api/models",
      "/api/auth/session",
      "/backend-api/models",
    ])
  })
})
