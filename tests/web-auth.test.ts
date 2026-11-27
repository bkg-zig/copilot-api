import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/auth/request-auth"
import { isDashboardSessionRequest } from "~/lib/auth/web-session"

import {
  createWebAuthService,
  initializeWebAuthDatabase,
  WEB_SESSION_TTL_SECONDS,
} from "~/lib/auth/web-session"
import {
  openSqliteDatabase,
  type SqliteDatabase,
  type SqliteRow,
} from "~/lib/storage/sqlite"

async function createTestService(now: () => number = Date.now) {
  const db = await openSqliteDatabase(":memory:")
  initializeWebAuthDatabase(db)
  const service = createWebAuthService({
    getDb: () => Promise.resolve(db),
    allowedEmail: "bkg@eysho.info",
    now,
  })
  return { db, service }
}

describe("Copi web authentication", () => {
  test("allows only the configured first account and permanently disables setup after registration", async () => {
    const { db, service } = await createTestService()
    try {
      expect(await service.status()).toEqual({ needsSetup: true })
      expect(
        service.register(
          "attacker@example.com",
          "correct horse battery staple",
        ),
      ).rejects.toMatchObject({ code: "AUTH_EMAIL_NOT_ALLOWED", status: 403 })

      const user = await service.register(
        "BKG@eysho.info",
        "a-strong-password-for-copi",
      )
      expect(user).toEqual({ id: 1, email: "bkg@eysho.info" })
      expect(await service.status()).toEqual({ needsSetup: false })
      expect(
        service.register("bkg@eysho.info", "another-strong-password"),
      ).rejects.toMatchObject({
        code: "AUTH_SETUP_ALREADY_COMPLETED",
        status: 403,
      })

      const stored = db
        .prepare<{
          password_hash: string
        }>("SELECT password_hash FROM web_auth_users WHERE id = 1")
        .get()
      expect(stored?.password_hash).toStartWith("$argon2id$")
    } finally {
      db.close?.()
    }
  })

  test("issues opaque server-side sessions, verifies login and revokes logout", async () => {
    const { db, service } = await createTestService()
    try {
      await service.register("bkg@eysho.info", "a-strong-password-for-copi")
      expect(
        service.login("bkg@eysho.info", "not-the-password"),
      ).rejects.toMatchObject({
        code: "AUTH_INVALID_CREDENTIALS",
        status: 401,
      })
      const user = await service.login(
        "BKG@EYSHO.INFO",
        "a-strong-password-for-copi",
      )
      expect(user.email).toBe("bkg@eysho.info")

      const session = await service.createSession("test-client")
      expect(session.token.length).toBeGreaterThanOrEqual(40)
      expect(await service.getSession(session.token)).toEqual(user)
      const stored = db
        .prepare<{
          token_hash: string
          user_agent: string
        }>("SELECT token_hash, user_agent FROM web_auth_sessions LIMIT 1")
        .get()
      expect(stored?.token_hash).not.toBe(session.token)
      expect(stored?.user_agent).toBe("test-client")

      await service.revokeSession(session.token)
      expect(await service.getSession(session.token)).toBeNull()
    } finally {
      db.close?.()
    }
  })

  test("admin password reset replaces the hash, preserves the email and revokes every session", async () => {
    const { db, service } = await createTestService()
    try {
      await service.register("bkg@eysho.info", "a-strong-password-for-copi")
      const oldHash = db
        .prepare<{
          password_hash: string
        }>("SELECT password_hash FROM web_auth_users WHERE id = 1")
        .get()?.password_hash
      const firstSession = await service.createSession("first-client")
      const secondSession = await service.createSession("second-client")

      const result = await service.resetPassword("a-new-strong-password")

      expect(result.user).toEqual({ id: 1, email: "bkg@eysho.info" })
      expect(result.sessionsRevoked).toBe(2)
      const stored = db
        .prepare<{
          email: string
          password_hash: string
        }>("SELECT email, password_hash FROM web_auth_users WHERE id = 1")
        .get()
      expect(stored?.email).toBe("bkg@eysho.info")
      expect(stored?.password_hash).not.toBe(oldHash)
      expect(await service.getSession(firstSession.token)).toBeNull()
      expect(await service.getSession(secondSession.token)).toBeNull()
      expect(
        service.login("bkg@eysho.info", "a-strong-password-for-copi"),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" })
      expect(
        await service.login("bkg@eysho.info", "a-new-strong-password"),
      ).toEqual({ id: 1, email: "bkg@eysho.info" })
    } finally {
      db.close?.()
    }
  })

  test("admin password reset refuses invalid passwords and an unconfigured account", async () => {
    const { db, service } = await createTestService()
    try {
      expect(service.resetPassword("bkg@eysho.info")).rejects.toMatchObject({
        code: "AUTH_ACCOUNT_NOT_CONFIGURED",
        status: 409,
      })
      expect(service.resetPassword("too-short")).rejects.toMatchObject({
        code: "AUTH_PASSWORD_TOO_SHORT",
        status: 400,
      })
      expect(service.resetPassword("x".repeat(1025))).rejects.toMatchObject({
        code: "AUTH_PASSWORD_TOO_SHORT",
        status: 400,
      })
      expect(service.resetPassword(null)).rejects.toMatchObject({
        code: "AUTH_PASSWORD_TOO_SHORT",
        status: 400,
      })
      await service.register("bkg@eysho.info", "a-strong-password-for-copi")
      expect(
        (await service.resetPassword("a-new-strong-password")).user.id,
      ).toBe(1)
    } finally {
      db.close?.()
    }
  })

  test("a failed admin password reset rolls back the hash and all sessions", async () => {
    const { db, service } = await createTestService()
    try {
      await service.register("bkg@eysho.info", "a-strong-password-for-copi")
      const session = await service.createSession()
      const oldHash = db
        .prepare<{
          password_hash: string
        }>("SELECT password_hash FROM web_auth_users WHERE id = 1")
        .get()?.password_hash
      const failingDb: SqliteDatabase = {
        exec: (sql) => db.exec(sql),
        prepare: <Row = SqliteRow>(sql: string) => {
          if (sql.startsWith("DELETE FROM web_auth_sessions")) {
            throw new Error("simulated session deletion failure")
          }
          return db.prepare<Row>(sql)
        },
      }
      const failingService = createWebAuthService({
        getDb: () => Promise.resolve(failingDb),
        allowedEmail: "bkg@eysho.info",
      })

      expect(
        failingService.resetPassword("a-new-strong-password"),
      ).rejects.toMatchObject({
        code: "AUTH_PASSWORD_RESET_FAILED",
        status: 500,
      })
      expect(
        db
          .prepare<{
            password_hash: string
          }>("SELECT password_hash FROM web_auth_users WHERE id = 1")
          .get()?.password_hash,
      ).toBe(oldHash)
      expect(await service.getSession(session.token)).toEqual({
        id: 1,
        email: "bkg@eysho.info",
      })
      expect(
        service.login("bkg@eysho.info", "a-new-strong-password"),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_CREDENTIALS" })
    } finally {
      db.close?.()
    }
  })

  test("web sessions authorize dashboard operations but never authorize model completions", async () => {
    const app = new Hono()
    const lookup = (context: import("hono").Context) =>
      Promise.resolve(
        (
          context.req
            .header("cookie")
            ?.includes("copi_session=valid-session-token")
        ) ?
          { id: 1, email: "bkg@eysho.info" }
        : null,
      )
    app.use(
      "*",
      createAuthMiddleware({
        getApiKeys: () => [],
        allowWhenNoApiKeys: false,
        authorizeRequest: (context) =>
          isDashboardSessionRequest(context, lookup),
      }),
    )
    app.get("/usage", (c) => c.text("usage-ok"))
    app.get("/admin/config/providers", (c) => c.text("provider-admin-ok"))
    app.get("/auth/providers/status", (c) => c.text("provider-auth-status-ok"))
    app.post("/auth/providers/codex/start", (c) => c.text("codex-login-ok"))
    app.post("/admin/config/providers/bkg-api/models/discover", (c) =>
      c.text("discovery-ok"),
    )
    app.post("/admin/auth/reset-password", (c) => c.text("reset-ok"))
    app.post("/v1/chat/completions", (c) => c.text("chat-ok"))
    app.post("/v1/responses", (c) => c.text("responses-ok"))
    app.post("/v1/messages", (c) => c.text("messages-ok"))

    const headers = { cookie: "copi_session=valid-session-token" }
    expect((await app.request("/usage", { headers })).status).toBe(200)
    expect(
      (await app.request("/admin/config/providers", { headers })).status,
    ).toBe(200)
    expect(
      (await app.request("/auth/providers/status", { headers })).status,
    ).toBe(200)
    expect(
      (
        await app.request("/auth/providers/codex/start", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request("/admin/config/providers/bkg-api/models/discover", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(200)
    expect(
      (await app.request("/v1/chat/completions", { method: "POST", headers }))
        .status,
    ).toBe(200)
    expect(
      (await app.request("/v1/responses", { method: "POST", headers })).status,
    ).toBe(200)
    expect(
      (await app.request("/v1/messages", { method: "POST", headers })).status,
    ).toBe(200)
    expect(
      (
        await app.request("/admin/auth/reset-password", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(401)
    expect(
      (await app.request("/v1/chat/completions", { method: "POST" })).status,
    ).toBe(401)
    expect((await app.request("/usage")).status).toBe(401)
  })

  test("expires sessions after the configured lifetime", async () => {
    let timestamp = 1_800_000_000_000
    const { db, service } = await createTestService(() => timestamp)
    try {
      await service.register("bkg@eysho.info", "a-strong-password-for-copi")
      const session = await service.createSession()
      expect(session.expiresAt).toBe(timestamp + WEB_SESSION_TTL_SECONDS * 1000)
      timestamp += WEB_SESSION_TTL_SECONDS * 1000 + 1
      expect(await service.getSession(session.token)).toBeNull()
    } finally {
      db.close?.()
    }
  })
})
