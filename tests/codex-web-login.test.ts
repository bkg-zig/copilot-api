import { describe, expect, test } from "bun:test"

import type { CodexCredentials } from "~/lib/oauth/codex"

import { CODEX_REDIRECT_URI } from "~/lib/oauth/codex"
import {
  CodexWebLoginError,
  createCodexWebLogin,
  normalizeCodexAlias,
} from "~/lib/oauth/codex-web-login"

function setup() {
  let now = 1_000
  let counter = 0
  const persisted: Array<{ accountId: string; alias?: string }> = []
  const exchanged: Array<{
    code: string
    verifier: string
    redirectUri: string
  }> = []
  const login = createCodexWebLogin({
    createAuthUrl: (redirectUri = CODEX_REDIRECT_URI) => {
      counter += 1
      return Promise.resolve({
        url: `https://auth.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=s${counter}`,
        state: `s${counter}`,
        verifier: `v${counter}`,
      })
    },
    completeAuth: (options) => {
      exchanged.push({
        code: options.code,
        verifier: options.verifier,
        redirectUri: options.redirectUri,
      })
      const credentials: CodexCredentials = {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 0,
        accountId: `acct-${options.code}`,
      }
      return Promise.resolve(credentials)
    },
    persist: (credentials, alias) => {
      persisted.push({ accountId: credentials.accountId, alias })
      return Promise.resolve()
    },
    now: () => now,
  })
  return {
    login,
    persisted,
    exchanged,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("normalizeCodexAlias", () => {
  test("accepts empty and simple aliases, rejects others", () => {
    expect(normalizeCodexAlias(undefined)).toBeUndefined()
    expect(normalizeCodexAlias(null)).toBeUndefined()
    expect(normalizeCodexAlias("  ")).toBeUndefined()
    expect(normalizeCodexAlias(" work ")).toBe("work")
    expect(() => normalizeCodexAlias(5)).toThrow(CodexWebLoginError)
    expect(() => normalizeCodexAlias("bad alias!")).toThrow("Alias may only")
  })
})

describe("Codex web login", () => {
  test("uses the registered localhost redirect and keeps the verifier server-side", async () => {
    const { login } = setup()
    const started = await login.start("work")
    expect(started.redirectUri).toBe("http://localhost:1455/auth/callback")
    expect(started.authUrl).toContain(encodeURIComponent(CODEX_REDIRECT_URI))
    expect(Object.keys(started)).not.toContain("verifier")
    expect(login.pendingCount()).toBe(1)
  })

  test("completes with the pasted redirect address", async () => {
    const { login, persisted, exchanged } = setup()
    const { state } = await login.start("work")
    const result = await login.finish(
      state,
      `http://localhost:1455/auth/callback?code=abc&state=${state}`,
    )
    expect(result).toEqual({ accountId: "acct-abc", alias: "work" })
    expect(exchanged).toEqual([
      { code: "abc", verifier: "v1", redirectUri: CODEX_REDIRECT_URI },
    ])
    expect(persisted).toEqual([{ accountId: "acct-abc", alias: "work" }])
    expect(login.pendingCount()).toBe(0)
  })

  test("accepts a bare code", async () => {
    const { login } = setup()
    const { state } = await login.start()
    expect((await login.finish(state, "plaincode")).accountId).toBe(
      "acct-plaincode",
    )
  })

  test("rejects a state mismatch without consuming the login", async () => {
    const { login, exchanged } = setup()
    const { state } = await login.start()
    expect(
      login.finish(
        state,
        "http://localhost:1455/auth/callback?code=x&state=other",
      ),
    ).rejects.toThrow("different sign-in")
    expect(exchanged).toHaveLength(0)
    expect(login.pendingCount()).toBe(1)
  })

  test("rejects unknown, expired and reused logins", async () => {
    const { login, advance } = setup()
    expect(login.finish("nope", "code")).rejects.toThrow("expired")
    const first = await login.start()
    await login.finish(first.state, "c1")
    expect(login.finish(first.state, "c1")).rejects.toThrow("already used")
    const second = await login.start()
    advance(11 * 60 * 1000)
    expect(login.finish(second.state, "c2")).rejects.toThrow("expired")
  })

  test("validates inputs", async () => {
    const { login } = setup()
    const { state } = await login.start()
    expect(login.finish(undefined, "c")).rejects.toThrow("Missing login state")
    expect(login.finish(state, "  ")).rejects.toThrow("Paste the full address")
    expect(
      login.finish(state, "http://localhost:1455/auth/callback?state=" + state),
    ).rejects.toThrow("No authorization code")
    expect(login.start("bad alias!")).rejects.toThrow(CodexWebLoginError)
  })

  test("caps the number of pending logins", async () => {
    const { login } = setup()
    for (let index = 0; index < 25; index++) await login.start()
    expect(login.pendingCount()).toBe(20)
  })
})
