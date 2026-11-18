import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildClaudeAuthorizeUrl,
  ClaudeOAuthError,
  CLAUDE_OAUTH_AUTHORIZE_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_USAGE_URL,
  clearClaudeCredentialsAt,
  createClaudeOAuthLogin,
  createPkcePair,
  exchangeClaudeAuthorizationCode,
  fetchClaudeOAuthUsage,
  getClaudeAccessToken,
  isClaudeCredentialsExpired,
  parseClaudeSubmittedCode,
  readClaudeCredentialsAt,
  refreshClaudeCredentials,
  writeClaudeCredentialsAt,
  type ClaudeOAuthCredentials,
} from "~/lib/claude-code/oauth"

let directory: string
let credentialPath: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-oauth-"))
  credentialPath = path.join(directory, "claude_oauth.json")
})

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

type FetchHandler = (
  input: string | URL | Request,
  init?: { body?: string | null; headers?: Record<string, string> },
) => Response

function asFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, {
    preconnect: () => {},
  }) as unknown as typeof fetch
}

function urlString(input: string | URL | Request): string {
  if (typeof input === "string") return input
  return input instanceof URL ? input.href : input.url
}

function credentials(
  overrides: Partial<ClaudeOAuthCredentials> = {},
): ClaudeOAuthCredentials {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 60 * 60 * 1000,
    email: "user@example.com",
    accountId: "account-1",
    ...overrides,
  }
}

describe("claude oauth helpers", () => {
  test("creates an S256 PKCE pair", () => {
    const pair = createPkcePair()
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(pair.codeChallenge).not.toBe(pair.codeVerifier)
  })

  test("builds the authorize URL with readable scope colons", () => {
    const url = new URL(
      buildClaudeAuthorizeUrl({
        state: "state-1",
        codeChallenge: "challenge-1",
      }),
    )
    expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_OAUTH_AUTHORIZE_URL)
    expect(url.searchParams.get("client_id")).toBe(CLAUDE_OAUTH_CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_OAUTH_REDIRECT_URI)
    expect(url.searchParams.get("code")).toBe("true")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1")
    expect(url.searchParams.get("state")).toBe("state-1")
    // Scopes are space-separated per RFC 6749; colons stay readable
    expect(url.searchParams.get("scope")).toBe(
      "org:create_api_key user:profile user:inference",
    )
  })

  test("parses a bare code, code#state and a callback URL", () => {
    expect(parseClaudeSubmittedCode(" abc123 ")).toEqual({ code: "abc123" })
    expect(parseClaudeSubmittedCode("abc123#state-1")).toEqual({
      code: "abc123",
      state: "state-1",
    })
    // Old callback URL format (backward compatibility)
    expect(
      parseClaudeSubmittedCode(
        "http://localhost:54545/callback?code=abc123&state=state-1",
      ),
    ).toEqual({ code: "abc123", state: "state-1" })
    // New callback URL format (platform.claude.com)
    expect(
      parseClaudeSubmittedCode(
        "https://platform.claude.com/oauth/code/callback?code=abc123&state=state-1",
      ),
    ).toEqual({ code: "abc123", state: "state-1" })
  })

  test("rejects empty, placeholder and malformed submissions", () => {
    expect(parseClaudeSubmittedCode("")).toBeNull()
    expect(parseClaudeSubmittedCode("true")).toBeNull()
    expect(
      parseClaudeSubmittedCode("http://localhost:54545/callback?code=true"),
    ).toBeNull()
    expect(
      parseClaudeSubmittedCode(
        "https://platform.claude.com/oauth/code/callback?code=true",
      ),
    ).toBeNull()
    expect(
      parseClaudeSubmittedCode("http://localhost:54545/callback?state=x"),
    ).toBeNull()
    expect(
      parseClaudeSubmittedCode(
        "https://platform.claude.com/oauth/code/callback?state=x",
      ),
    ).toBeNull()
  })

  test("treats tokens inside the refresh buffer as expired", () => {
    const now = 1_000_000
    expect(isClaudeCredentialsExpired({ expiresAt: now + 1 }, now)).toBe(true)
    expect(isClaudeCredentialsExpired({ expiresAt: now + 120_000 }, now)).toBe(
      false,
    )
  })
})

describe("claude credential store", () => {
  test("returns null when no credential file exists", async () => {
    expect(await readClaudeCredentialsAt(credentialPath)).toBeNull()
  })

  test("writes 0600 credentials and reads them back", async () => {
    await writeClaudeCredentialsAt(credentialPath, credentials())
    const stored = await readClaudeCredentialsAt(credentialPath)
    expect(stored?.accessToken).toBe("access-1")
    expect(stored?.email).toBe("user@example.com")
    const mode = (await fs.stat(credentialPath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("rejects corrupt and incomplete files", async () => {
    await fs.writeFile(credentialPath, "{not json")
    expect(readClaudeCredentialsAt(credentialPath)).rejects.toThrow(
      ClaudeOAuthError,
    )
    await fs.writeFile(credentialPath, JSON.stringify({ version: 1 }))
    expect(readClaudeCredentialsAt(credentialPath)).rejects.toThrow(
      ClaudeOAuthError,
    )
  })

  test("clears the credential file", async () => {
    await writeClaudeCredentialsAt(credentialPath, credentials())
    await clearClaudeCredentialsAt(credentialPath)
    expect(await readClaudeCredentialsAt(credentialPath)).toBeNull()
  })
})

describe("claude token exchange", () => {
  test("exchanges an authorization code", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const result = await exchangeClaudeAuthorizationCode(
      { code: "code-1", state: "state-1", codeVerifier: "verifier-1" },
      {
        now: () => 5_000,
        fetch: asFetch((url, init) => {
          calls.push({
            url: urlString(url),
            body: JSON.parse(String(init?.body)),
          })
          return jsonResponse({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
            account: { uuid: "uuid-1", email_address: "a@b.c" },
          })
        }),
      },
    )
    expect(calls[0]?.url).toBe(CLAUDE_OAUTH_TOKEN_URL)
    expect(calls[0]?.body).toMatchObject({
      code: "code-1",
      grant_type: "authorization_code",
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      code_verifier: "verifier-1",
      state: "state-1",
    })
    expect(result).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      email: "a@b.c",
      accountId: "uuid-1",
      expiresAt: 5_000 + 3_600_000,
    })
  })

  test("reports a rejected exchange", () => {
    expect(
      exchangeClaudeAuthorizationCode(
        { code: "bad", state: "s", codeVerifier: "v" },
        {
          fetch: asFetch(() =>
            jsonResponse(
              { error: "invalid_grant", error_description: "expired" },
              400,
            ),
          ),
        },
      ),
    ).rejects.toThrow(/HTTP 400\): invalid_grant/iu)
  })

  test("reports malformed token responses", () => {
    expect(
      exchangeClaudeAuthorizationCode(
        { code: "c", state: "s", codeVerifier: "v" },
        {
          fetch: asFetch(() => jsonResponse({ nope: true })),
        },
      ),
    ).rejects.toThrow(/unexpected token response/iu)
  })

  test("requires a refresh token on the first login", () => {
    expect(
      exchangeClaudeAuthorizationCode(
        { code: "c", state: "s", codeVerifier: "v" },
        {
          fetch: asFetch(() =>
            jsonResponse({
              access_token: "a",
              expires_in: 60,
            }),
          ),
        },
      ),
    ).rejects.toThrow(/refresh token/iu)
  })

  test("refreshes and keeps the previous refresh token when omitted", async () => {
    const result = await refreshClaudeCredentials(credentials(), {
      now: () => 10_000,
      fetch: asFetch((_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          grant_type?: string
          refresh_token?: string
          state?: string
        }
        expect(body.grant_type).toBe("refresh_token")
        expect(body.refresh_token).toBe("refresh-1")
        return jsonResponse({ access_token: "access-3", expires_in: 120 })
      }),
    })
    expect(result.accessToken).toBe("access-3")
    expect(result.refreshToken).toBe("refresh-1")
    expect(result.expiresAt).toBe(10_000 + 120_000)
    expect(result.email).toBe("user@example.com")
  })

  test("keeps a one hour fallback when expires_in is missing", async () => {
    const result = await refreshClaudeCredentials(credentials(), {
      now: () => 0,
      fetch: asFetch(() =>
        jsonResponse({
          access_token: "a",
          refresh_token: "r",
        }),
      ),
    })
    expect(result.expiresAt).toBe(3_600_000)
  })

  test("reports a failed refresh", () => {
    expect(
      refreshClaudeCredentials(credentials(), {
        fetch: asFetch(() => jsonResponse({}, 503)),
      }),
    ).rejects.toThrow(/HTTP 503/iu)
  })
})

describe("claude access token", () => {
  test("returns null without credentials", async () => {
    expect(await getClaudeAccessToken({ credentialPath })).toBeNull()
  })

  test("returns a fresh token without a network call", async () => {
    await writeClaudeCredentialsAt(
      credentialPath,
      credentials({ expiresAt: Date.now() + 3_600_000 }),
    )
    let calls = 0
    const token = await getClaudeAccessToken({
      credentialPath,
      fetch: asFetch(() => {
        calls += 1
        return jsonResponse({})
      }),
    })
    expect(token).toBe("access-1")
    expect(calls).toBe(0)
  })

  test("refreshes and persists an expired token", async () => {
    await writeClaudeCredentialsAt(
      credentialPath,
      credentials({ expiresAt: Date.now() - 1000 }),
    )
    const token = await getClaudeAccessToken({
      credentialPath,
      fetch: asFetch(() =>
        jsonResponse({
          access_token: "access-new",
          refresh_token: "refresh-new",
          expires_in: 3600,
        }),
      ),
    })
    expect(token).toBe("access-new")
    expect((await readClaudeCredentialsAt(credentialPath))?.refreshToken).toBe(
      "refresh-new",
    )
  })

  test("drops credentials when the refresh token is dead", async () => {
    await writeClaudeCredentialsAt(
      credentialPath,
      credentials({ expiresAt: Date.now() - 1000 }),
    )
    const token = await getClaudeAccessToken({
      credentialPath,
      fetch: asFetch(() => jsonResponse({ error: "invalid_grant" }, 400)),
    })
    expect(token).toBeNull()
    expect(await readClaudeCredentialsAt(credentialPath)).toBeNull()
  })

  test("propagates transient refresh failures without deleting", async () => {
    await writeClaudeCredentialsAt(
      credentialPath,
      credentials({ expiresAt: Date.now() - 1000 }),
    )
    expect(
      getClaudeAccessToken({
        credentialPath,
        fetch: asFetch(() => jsonResponse({}, 500)),
      }),
    ).rejects.toThrow(/HTTP 500/iu)
    expect(await readClaudeCredentialsAt(credentialPath)).not.toBeNull()
  })
})

describe("claude usage", () => {
  test("fetches usage with the OAuth headers", async () => {
    await writeClaudeCredentialsAt(
      credentialPath,
      credentials({ expiresAt: Date.now() + 3_600_000 }),
    )
    const seen: Headers[] = []
    const value = await fetchClaudeOAuthUsage({
      credentialPath,
      fetch: asFetch(
        (
          url: string | URL | Request,
          init?: { headers?: Record<string, string> },
        ) => {
          expect(urlString(url)).toBe(CLAUDE_OAUTH_USAGE_URL)
          seen.push(new Headers(init?.headers))
          return jsonResponse({ five_hour: { utilization: 9 } })
        },
      ),
    })
    expect(value).toEqual({ five_hour: { utilization: 9 } })
    expect(seen[0]?.get("authorization")).toBe("Bearer access-1")
    expect(seen[0]?.get("anthropic-beta")).toBe("oauth-2025-04-20")
  })

  test("refreshes once on a 401 and retries", async () => {
    await writeClaudeCredentialsAt(
      credentialPath,
      credentials({ expiresAt: Date.now() + 3_600_000 }),
    )
    let usageCalls = 0
    const value = await fetchClaudeOAuthUsage({
      credentialPath,
      fetch: asFetch((url) => {
        const target = urlString(url)
        if (target === CLAUDE_OAUTH_TOKEN_URL) {
          return jsonResponse({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 3600,
          })
        }
        usageCalls += 1
        return usageCalls === 1 ?
            jsonResponse({}, 401)
          : jsonResponse({ seven_day: { utilization: 40 } })
      }),
    })
    expect(value).toEqual({ seven_day: { utilization: 40 } })
    expect(usageCalls).toBe(2)
  })

  test("throws when nobody is signed in", () => {
    expect(fetchClaudeOAuthUsage({ credentialPath })).rejects.toThrow(
      /not signed in/iu,
    )
  })

  test("throws a sanitized error for a failed usage request", async () => {
    await writeClaudeCredentialsAt(
      credentialPath,
      credentials({ expiresAt: Date.now() + 3_600_000 }),
    )
    expect(
      fetchClaudeOAuthUsage({
        credentialPath,
        fetch: asFetch(
          () =>
            new Response("secret details", {
              status: 429,
            }),
        ),
      }),
    ).rejects.toThrow(/HTTP 429/iu)
  })
})

describe("claude login manager", () => {
  test("starts a sign-in, completes it and reports status", async () => {
    const login = createClaudeOAuthLogin({
      credentialPath,
      now: () => 1_000,
      fetch: asFetch((_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          grant_type?: string
          refresh_token?: string
          state?: string
        }
        return jsonResponse({
          access_token: "access-9",
          refresh_token: "refresh-9",
          expires_in: 3600,
          account: { email_address: "user@example.com" },
          // Echo the state so the exchange matches the pending session.
          state: body.state,
        })
      }),
    })
    expect(await login.status()).toEqual({ available: true, loggedIn: false })
    const started = login.start()
    expect(typeof started.flowId).toBe("string")
    expect(started.authUrl.startsWith(CLAUDE_OAUTH_AUTHORIZE_URL)).toBe(true)
    expect(login.pendingCount()).toBe(1)

    const status = await login.submit(started.flowId, "the-code")
    expect(status.loggedIn).toBe(true)
    expect(status.email).toBe("user@example.com")
    expect(status.authMethod).toBe("oauth_token")
    expect(login.pendingCount()).toBe(0)
    expect((await login.status()).loggedIn).toBe(true)
    expect(await login.logout()).toEqual({ available: true, loggedIn: false })
  })

  test("rejects reused, expired and missing sessions", async () => {
    let now = 0
    const login = createClaudeOAuthLogin({
      credentialPath,
      now: () => now,
      fetch: asFetch(() =>
        jsonResponse({
          access_token: "a",
          refresh_token: "r",
          expires_in: 60,
        }),
      ),
    })
    const started = login.start()
    await login.submit(started.flowId, "code")
    expect(login.submit(started.flowId, "code")).rejects.toThrow(
      /expired or was already used/iu,
    )

    const expired = login.start()
    now += 11 * 60 * 1000
    expect(login.submit(expired.flowId, "code")).rejects.toThrow(
      /expired or was already used/iu,
    )

    expect(login.submit(undefined, "code")).rejects.toThrow(
      /Missing sign-in session/iu,
    )
    expect(login.submit("missing", "")).rejects.toThrow(
      /Paste the login code/iu,
    )
  })

  test("rejects an invalid code and a state mismatch", () => {
    const login = createClaudeOAuthLogin({ credentialPath })
    const invalid = login.start()
    expect(login.submit(invalid.flowId, "   ")).rejects.toThrow(
      /Paste the login code/iu,
    )

    const mismatch = login.start()
    expect(login.submit(mismatch.flowId, "code#wrong-state")).rejects.toThrow(
      /different sign-in attempt/iu,
    )
  })

  test("wraps network failures during the exchange", () => {
    const login = createClaudeOAuthLogin({
      credentialPath,
      fetch: asFetch(() => {
        throw new Error("offline")
      }),
    })
    const started = login.start()
    expect(login.submit(started.flowId, "code")).rejects.toThrow(
      /Could not reach Anthropic/iu,
    )
  })

  test("cancels a pending sign-in", () => {
    const login = createClaudeOAuthLogin({ credentialPath })
    const started = login.start()
    expect(login.cancel(started.flowId)).toBe(true)
    expect(login.cancel(started.flowId)).toBe(false)
    expect(login.pendingCount()).toBe(0)
  })

  test("caps pending sign-ins", () => {
    const login = createClaudeOAuthLogin({ credentialPath })
    for (let index = 0; index < 7; index += 1) login.start()
    expect(login.pendingCount()).toBe(5)
  })

  test("reports unreadable credentials in status", async () => {
    await fs.writeFile(credentialPath, "{broken")
    const login = createClaudeOAuthLogin({ credentialPath })
    const status = await login.status()
    expect(status.loggedIn).toBe(false)
    expect(status.error).toContain("not valid JSON")
  })
})
