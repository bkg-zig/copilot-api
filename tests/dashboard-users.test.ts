import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import * as configModule from "~/lib/config"
import { setMailSenderForTesting, type MailMessage } from "~/lib/mailer"
import { resolveProviderAuthType } from "~/lib/provider-config"
import { openSqliteDatabase, type SqliteDatabase } from "~/lib/sqlite"
import {
  initializeUserTables,
  setUserStoreForTesting,
  UserStore,
  UserStoreError,
} from "~/lib/users"
import {
  resetAuthRouteStateForTesting,
  seedAdminFromEnv,
  SESSION_COOKIE_NAME,
} from "~/routes/auth/route"
import { createServer } from "~/server"

const PASSWORD = "correct-horse-1"
const ADMIN_EMAIL = "boss@example.com"
const ADMIN_KEY = "admin-key-test"
const BASE = "https://api.example.com"

let tempDir: string
let db: SqliteDatabase
let now: number
let store: UserStore
let mails: Array<MailMessage>
const ENV_KEYS = [
  "COPILOT_API_ADMIN_EMAIL",
  "COPILOT_API_PUBLIC_URL",
  "COPILOT_API_ALLOWED_ORIGINS",
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-users-"))
  db = await openSqliteDatabase(path.join(tempDir, "users.sqlite"))
  initializeUserTables(db)
  now = 1_000_000
  store = new UserStore(
    () => Promise.resolve(db),
    () => now,
  )
  setUserStoreForTesting(store)
  mails = []
  setMailSenderForTesting((message) => {
    mails.push(message)
    return Promise.resolve()
  })
  resetAuthRouteStateForTesting()
  process.env.COPILOT_API_ADMIN_EMAIL = ADMIN_EMAIL
  process.env.COPILOT_API_PUBLIC_URL = "https://dash.example.com/ignored-path"
})

afterEach(() => {
  configSpy?.mockRestore()
  configSpy = undefined
  setUserStoreForTesting(undefined)
  setMailSenderForTesting(undefined)
  db.close?.()
  fs.rmSync(tempDir, { recursive: true, force: true })
  // Restore key by key: replacing process.env breaks env for later files.
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

let configSpy: { mockRestore: () => void } | undefined

function mockAdminKey(adminApiKey: string | undefined): void {
  const realConfig = configModule.getConfig()
  configSpy = spyOn(configModule, "getConfig").mockReturnValue({
    ...realConfig,
    auth: { ...realConfig.auth, adminApiKey },
  })
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? ""
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header)
  if (!match) throw new Error(`No session cookie in: ${header}`)
  return `${SESSION_COOKIE_NAME}=${match[1]}`
}

function linkToken(message: MailMessage): string {
  const match = /auth_token=([\w%-]+)/.exec(message.text)
  if (!match) throw new Error(`No link in mail: ${message.text}`)
  return decodeURIComponent(match[1])
}

function createApp(): ReturnType<typeof createServer> {
  return createServer({ networkExposed: true, getApiKeys: () => ["gw-key"] })
}

function post(
  app: ReturnType<typeof createServer>,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`${BASE}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  )
}

async function loginAs(
  app: ReturnType<typeof createServer>,
  email: string,
): Promise<string> {
  return sessionCookie(
    await post(app, "/auth/login", { email, password: PASSWORD }),
  )
}

describe("UserStore (SQLite)", () => {
  test("creates users with hashed passwords", async () => {
    const user = await store.createUser(
      " Alice@Example.com ",
      PASSWORD,
      "admin",
    )
    expect(user.email).toBe("alice@example.com")
    expect(user.hasPassword).toBe(true)
    const row = db
      .prepare("SELECT password_hash FROM dashboard_users")
      .get() as { password_hash: string }
    expect(row.password_hash).not.toContain(PASSWORD)
    expect(await store.hasUsers()).toBe(true)
    expect(await store.getUser("nobody@example.com")).toBeUndefined()
    const invited = await store.createUser("bob@example.com", undefined, "user")
    expect(invited.hasPassword).toBe(false)
    expect(await store.verifyCredentials("bob@example.com", "")).toBeNull()
  })

  test("validates email, password and role", async () => {
    expect(store.createUser("no-at-sign", PASSWORD, "user")).rejects.toThrow(
      UserStoreError,
    )
    expect(store.createUser(5, PASSWORD, "user")).rejects.toThrow("valid email")
    expect(store.createUser("a@b.co", "short", "user")).rejects.toThrow(
      "Password must be",
    )
    expect(store.createUser("a@b.co", PASSWORD, "root")).rejects.toThrow(
      "Role must be",
    )
    await store.createUser("a@b.co", PASSWORD, "user")
    expect(store.createUser("A@B.co", PASSWORD, "user")).rejects.toThrow(
      "already exists",
    )
  })

  test("verifies credentials case-insensitively", async () => {
    await store.createUser("alice@example.com", PASSWORD, "user")
    expect(
      (await store.verifyCredentials("ALICE@example.com", PASSWORD))?.email,
    ).toBe("alice@example.com")
    expect(
      await store.verifyCredentials("alice@example.com", "wrong-pass-x"),
    ).toBeNull()
    expect(
      await store.verifyCredentials("bob@example.com", PASSWORD),
    ).toBeNull()
    expect(await store.verifyCredentials(undefined, PASSWORD)).toBeNull()
  })

  test("keeps at least one admin", async () => {
    await store.createUser("a@example.com", PASSWORD, "admin")
    expect(store.setRole("a@example.com", "user")).rejects.toThrow(
      "At least one admin",
    )
    expect(store.deleteUser("a@example.com")).rejects.toThrow(
      "At least one admin",
    )
    await store.createUser("b@example.com", PASSWORD, "admin")
    expect((await store.setRole("a@example.com", "user")).role).toBe("user")
    expect(store.deleteUser("x@example.com")).rejects.toThrow("not found")
    expect(store.setRole("x@example.com", "user")).rejects.toThrow("not found")
    expect(store.setPassword("x@example.com", PASSWORD)).rejects.toThrow(
      "not found",
    )
  })

  test("sessions persist, expire and follow role changes", async () => {
    await store.createUser("a@example.com", PASSWORD, "admin")
    await store.createUser("b@example.com", PASSWORD, "admin")
    const token = await store.createSession("a@example.com")
    expect((await store.getSession(token))?.role).toBe("admin")
    await store.setRole("a@example.com", "user")
    expect((await store.getSession(token))?.role).toBe("user")
    expect(await store.getSession(undefined)).toBeNull()
    expect(await store.getSession("unknown")).toBeNull()

    await store.setPassword("a@example.com", "another-pass-1")
    expect(await store.getSession(token)).toBeNull()

    const second = await store.createSession("a@example.com")
    now += 8 * 24 * 60 * 60 * 1000
    expect(await store.getSession(second)).toBeNull()

    const third = await store.createSession("a@example.com")
    await store.destroySession(third)
    await store.destroySession(undefined)
    expect(await store.getSession(third)).toBeNull()

    const fourth = await store.createSession("a@example.com")
    await store.deleteUser("a@example.com")
    expect(await store.getSession(fourth)).toBeNull()
  })

  test("email tokens are single-purpose, newest-only and expire", async () => {
    const first = await store.createEmailToken("a@example.com", "reset")
    const second = await store.createEmailToken("a@example.com", "reset")
    expect(await store.peekEmailToken(first)).toBeNull()
    expect((await store.peekEmailToken(second))?.purpose).toBe("reset")
    expect(await store.peekEmailToken(undefined)).toBeNull()
    await store.consumeEmailToken(second)
    expect(await store.peekEmailToken(second)).toBeNull()
    const third = await store.createEmailToken(
      "a@example.com",
      "setup",
      "admin",
    )
    now += 31 * 60 * 1000
    expect(await store.peekEmailToken(third)).toBeNull()
  })

  test("login limiter blocks after max failures and resets after the window", async () => {
    expect(await store.isLoginBlocked("ip", 2, 1000)).toBe(false)
    await store.recordLoginFailure("ip", 1000)
    await store.recordLoginFailure("ip", 1000)
    expect(await store.isLoginBlocked("ip", 2, 1000)).toBe(true)
    now += 1500
    expect(await store.isLoginBlocked("ip", 2, 1000)).toBe(false)
    await store.recordLoginFailure("ip", 1000)
    await store.resetLoginFailures("ip")
    expect(await store.isLoginBlocked("ip", 2, 1000)).toBe(false)
  })
})

describe("email setup of the first admin", () => {
  test("status reports the masked admin address", async () => {
    mockAdminKey(ADMIN_KEY)
    const response = await createApp().request(`${BASE}/auth/status`)
    expect(await response.json()).toEqual({
      setupRequired: true,
      setupByEmail: true,
      setupEmailHint: "b***@example.com",
      setupNeedsAdminKey: true,
      passwordResetAvailable: true,
      user: null,
    })
  })

  test("sends a one-time link only to the configured address", async () => {
    const app = createApp()
    const sent = await post(app, "/auth/setup/request", {})
    expect(await sent.json()).toEqual({ sent: true, to: "b***@example.com" })
    expect(mails).toHaveLength(1)
    expect(mails[0].to).toBe(ADMIN_EMAIL)
    expect(mails[0].text).toContain("https://dash.example.com/?auth_token=")

    // Cooldown against mail flooding.
    expect((await post(app, "/auth/setup/request", {})).status).toBe(429)

    const token = linkToken(mails[0])
    const inspect = await post(app, "/auth/link/inspect", { token })
    expect(await inspect.json()).toEqual({
      email: ADMIN_EMAIL,
      purpose: "setup",
    })

    expect(
      (await post(app, "/auth/link/complete", { token, password: "short" }))
        .status,
    ).toBe(400)
    const done = await post(app, "/auth/link/complete", {
      token,
      password: PASSWORD,
    })
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({
      user: { email: ADMIN_EMAIL, role: "admin" },
    })
    const cookie = done.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Secure")

    // The link works once, and setup cannot be requested again.
    expect(
      (await post(app, "/auth/link/complete", { token, password: PASSWORD }))
        .status,
    ).toBe(404)
    expect((await post(app, "/auth/link/inspect", { token })).status).toBe(404)
    expect((await post(app, "/auth/setup/request", {})).status).toBe(409)
  })

  test("is unavailable without mail settings", async () => {
    setMailSenderForTesting(null)
    expect((await post(createApp(), "/auth/setup/request", {})).status).toBe(
      503,
    )
    process.env.COPILOT_API_ADMIN_EMAIL = "not-an-email"
    setMailSenderForTesting(() => Promise.resolve())
    expect((await post(createApp(), "/auth/setup/request", {})).status).toBe(
      503,
    )
  })

  test("reports mail delivery failures and allows a retry", async () => {
    setMailSenderForTesting(() => Promise.reject(new Error("smtp down")))
    const app = createApp()
    expect((await post(app, "/auth/setup/request", {})).status).toBe(503)
    setMailSenderForTesting(() => Promise.resolve())
    expect((await post(app, "/auth/setup/request", {})).status).toBe(200)
  })

  test("public URL falls back to the first allowed origin", async () => {
    delete process.env.COPILOT_API_PUBLIC_URL
    process.env.COPILOT_API_ALLOWED_ORIGINS =
      "https://origin.example.com, https://other.example.com"
    await post(createApp(), "/auth/setup/request", {})
    expect(mails[0].text).toContain("https://origin.example.com/?auth_token=")
  })

  test("admin key fallback creates the admin directly", async () => {
    mockAdminKey(ADMIN_KEY)
    const app = createApp()
    const body = { email: "keyed@example.com", password: PASSWORD }
    expect((await post(app, "/auth/setup", body)).status).toBe(401)
    expect(
      (await post(app, "/auth/setup", { ...body, adminKey: ADMIN_KEY })).status,
    ).toBe(200)
    expect(
      (await post(app, "/auth/setup", { ...body, adminKey: ADMIN_KEY })).status,
    ).toBe(409)
  })

  test("admin key fallback is refused when no key is configured", async () => {
    mockAdminKey(undefined)
    expect(
      (
        await post(createApp(), "/auth/setup", {
          email: "x@example.com",
          password: PASSWORD,
        })
      ).status,
    ).toBe(403)
  })

  test("admin key fallback reports validation errors", async () => {
    mockAdminKey(ADMIN_KEY)
    expect(
      (
        await post(createApp(), "/auth/setup", {
          email: "bad",
          password: PASSWORD,
          adminKey: ADMIN_KEY,
        })
      ).status,
    ).toBe(400)
  })
})

describe("sign-in, roles and user management", () => {
  test("login session grants role-based access", async () => {
    await store.createUser("admin@example.com", PASSWORD, "admin")
    await store.createUser("user@example.com", PASSWORD, "user")
    const app = createApp()

    expect(
      (
        await post(app, "/auth/login", {
          email: "user@example.com",
          password: "nope-nope-nope",
        })
      ).status,
    ).toBe(401)
    const userCookie = await loginAs(app, "user@example.com")
    const adminCookie = await loginAs(app, "admin@example.com")

    expect((await app.request(`${BASE}/models`)).status).toBe(401)
    const me = await app.request(`${BASE}/auth/me`, {
      headers: { cookie: userCookie },
    })
    expect(await me.json()).toEqual({
      user: { email: "user@example.com", role: "user" },
    })
    expect(
      (
        await app.request(`${BASE}/admin/config/router`, {
          headers: { cookie: userCookie },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await app.request(`${BASE}/auth/users`, {
          headers: { cookie: userCookie },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(`${BASE}/admin/config/router`, {
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(200)

    await post(app, "/auth/logout", {}, { cookie: userCookie })
    expect(
      (
        await app.request(`${BASE}/auth/me`, {
          headers: { cookie: userCookie },
        })
      ).status,
    ).toBe(401)
  })

  test("admins invite users by email", async () => {
    await store.createUser("admin@example.com", PASSWORD, "admin")
    const app = createApp()
    const headers = { cookie: await loginAs(app, "admin@example.com") }

    const created = await post(
      app,
      "/auth/users",
      { email: "New@Example.com" },
      headers,
    )
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      user: { email: "new@example.com", role: "user", hasPassword: false },
      invited: true,
    })
    expect(mails.at(-1)?.to).toBe("new@example.com")
    expect(mails.at(-1)?.subject).toContain("invited")

    expect(
      (await post(app, "/auth/users", { email: "new@example.com" }, headers))
        .status,
    ).toBe(409)

    const token = linkToken(mails.at(-1) as MailMessage)
    const accepted = await post(app, "/auth/link/complete", {
      token,
      password: PASSWORD,
    })
    expect(await accepted.json()).toEqual({
      user: { email: "new@example.com", role: "user" },
    })

    const list = (await (
      await app.request(`${BASE}/auth/users`, { headers })
    ).json()) as {
      users: Array<{ email: string }>
      mailReady: boolean
    }
    expect(list.users.map((user) => user.email)).toEqual([
      "admin@example.com",
      "new@example.com",
    ])
    expect(list.mailReady).toBe(true)

    const patched = await app.request(
      `${BASE}/auth/users/${encodeURIComponent("new@example.com")}`,
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ role: "admin", password: "replaced-pass-1" }),
      },
    )
    expect(await patched.json()).toMatchObject({ user: { role: "admin" } })
    expect(
      (
        await app.request(`${BASE}/auth/users/missing%40example.com`, {
          method: "PATCH",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ role: "user" }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request(`${BASE}/auth/users/new%40example.com`, {
          method: "PATCH",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ role: "root" }),
        })
      ).status,
    ).toBe(400)

    const resent = await post(
      app,
      `/auth/users/${encodeURIComponent("new@example.com")}/send-link`,
      {},
      headers,
    )
    expect(resent.status).toBe(200)
    expect(mails.at(-1)?.subject).toContain("reset")
    expect(
      (
        await post(
          app,
          "/auth/users/missing%40example.com/send-link",
          {},
          headers,
        )
      ).status,
    ).toBe(404)

    expect(
      (
        await app.request(`${BASE}/auth/users/admin%40example.com`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await app.request(`${BASE}/auth/users/new%40example.com`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`${BASE}/auth/users/new%40example.com`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(404)
  })

  test("without mail, admins set an initial password", async () => {
    await store.createUser("admin@example.com", PASSWORD, "admin")
    const app = createApp()
    const headers = { cookie: await loginAs(app, "admin@example.com") }
    setMailSenderForTesting(null)
    expect(
      (await post(app, "/auth/users", { email: "x@example.com" }, headers))
        .status,
    ).toBe(400)
    const created = await post(
      app,
      "/auth/users",
      { email: "x@example.com", password: PASSWORD },
      headers,
    )
    expect(await created.json()).toMatchObject({
      user: { hasPassword: true },
      invited: false,
    })
    expect(
      (await post(app, "/auth/users/x%40example.com/send-link", {}, headers))
        .status,
    ).toBe(503)
  })

  test("invitation mail failure still creates the user", async () => {
    await store.createUser("admin@example.com", PASSWORD, "admin")
    const app = createApp()
    const headers = { cookie: await loginAs(app, "admin@example.com") }
    setMailSenderForTesting(() => Promise.reject(new Error("smtp down")))
    const created = await post(
      app,
      "/auth/users",
      { email: "y@example.com" },
      headers,
    )
    expect(await created.json()).toMatchObject({ invited: false })
    expect(
      (await post(app, "/auth/users/y%40example.com/send-link", {}, headers))
        .status,
    ).toBe(503)
  })

  test("forgot password mails a reset link without revealing accounts", async () => {
    await store.createUser("user@example.com", PASSWORD, "user")
    const app = createApp()
    expect(
      await (
        await post(app, "/auth/password/forgot", {
          email: "nobody@example.com",
        })
      ).json(),
    ).toEqual({ ok: true })
    expect(mails).toHaveLength(0)
    expect(
      await (await post(app, "/auth/password/forgot", { email: "bad" })).json(),
    ).toEqual({ ok: true })
    await post(app, "/auth/password/forgot", { email: "user@example.com" })
    expect(mails).toHaveLength(1)

    const oldCookie = await loginAs(app, "user@example.com")
    const token = linkToken(mails[0])
    const reset = await post(app, "/auth/link/complete", {
      token,
      password: "brand-new-pass-1",
    })
    expect(reset.status).toBe(200)
    expect(
      (await app.request(`${BASE}/auth/me`, { headers: { cookie: oldCookie } }))
        .status,
    ).toBe(401)
    expect(
      await store.verifyCredentials("user@example.com", "brand-new-pass-1"),
    ).not.toBeNull()

    // Rate limit per client.
    const headers = { "x-forwarded-for": "198.51.100.9" }
    for (let attempt = 0; attempt < 5; attempt++) {
      await post(
        app,
        "/auth/password/forgot",
        { email: "user@example.com" },
        headers,
      )
    }
    expect(
      (
        await post(
          app,
          "/auth/password/forgot",
          { email: "user@example.com" },
          headers,
        )
      ).status,
    ).toBe(429)

    setMailSenderForTesting(null)
    expect(
      (await post(app, "/auth/password/forgot", { email: "user@example.com" }))
        .status,
    ).toBe(503)
  })

  test("reset link for a deleted account is rejected", async () => {
    await store.createUser("gone@example.com", PASSWORD, "user")
    await store.createUser("admin@example.com", PASSWORD, "admin")
    const token = await store.createEmailToken("gone@example.com", "reset")
    db.prepare("DELETE FROM dashboard_users WHERE email = ?").run(
      "gone@example.com",
    )
    expect(
      (
        await post(createApp(), "/auth/link/complete", {
          token,
          password: PASSWORD,
        })
      ).status,
    ).toBe(404)
  })

  test("a setup link after setup is rejected", async () => {
    const token = await store.createEmailToken(ADMIN_EMAIL, "setup", "admin")
    await store.createUser("someone@example.com", PASSWORD, "admin")
    expect(
      (
        await post(createApp(), "/auth/link/complete", {
          token,
          password: PASSWORD,
        })
      ).status,
    ).toBe(409)
  })

  test("users change their own password", async () => {
    await store.createUser("user@example.com", PASSWORD, "user")
    const app = createApp()
    const cookie = await loginAs(app, "user@example.com")
    expect(
      (
        await post(app, "/auth/password", {
          currentPassword: "x",
          newPassword: "new-password-1",
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await post(
          app,
          "/auth/password",
          { currentPassword: "wrong-pass-1", newPassword: "new-password-1" },
          { cookie },
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await post(
          app,
          "/auth/password",
          { currentPassword: PASSWORD, newPassword: "short" },
          { cookie },
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await post(
          app,
          "/auth/password",
          { currentPassword: PASSWORD, newPassword: "new-password-1" },
          { cookie },
        )
      ).status,
    ).toBe(200)
    expect(
      await store.verifyCredentials("user@example.com", "new-password-1"),
    ).not.toBeNull()
  })

  test("rate limits repeated failed logins per client", async () => {
    const app = createApp()
    const headers = { "x-forwarded-for": "203.0.113.77" }
    for (let attempt = 0; attempt < 10; attempt++) {
      await post(
        app,
        "/auth/login",
        { email: "x@example.com", password: "y" },
        headers,
      )
    }
    expect(
      (
        await post(
          app,
          "/auth/login",
          { email: "x@example.com", password: "y" },
          headers,
        )
      ).status,
    ).toBe(429)
  })
})

describe("seedAdminFromEnv", () => {
  test("creates the first admin only once", async () => {
    const env = {
      COPILOT_API_ADMIN_EMAIL: "root@example.com",
      COPILOT_API_ADMIN_PASSWORD: PASSWORD,
    }
    expect(await seedAdminFromEnv({})).toBe(false)
    expect(await seedAdminFromEnv(env)).toBe(true)
    expect((await store.getUser("root@example.com"))?.role).toBe("admin")
    expect(await seedAdminFromEnv(env)).toBe(false)
  })

  test("ignores invalid credentials", async () => {
    expect(
      await seedAdminFromEnv({
        COPILOT_API_ADMIN_EMAIL: "root@example.com",
        COPILOT_API_ADMIN_PASSWORD: "short",
      }),
    ).toBe(false)
    expect(await store.hasUsers()).toBe(false)
  })
})

describe("chatgpt cookie auth type", () => {
  test("accepts cookie for chatgpt providers only", () => {
    expect(resolveProviderAuthType("chatgpt", "cookie", "chatgpt")).toBe(
      "cookie",
    )
    expect(
      resolveProviderAuthType("custom", "cookie", "openai-compatible"),
    ).toBe("authorization")
  })
})
