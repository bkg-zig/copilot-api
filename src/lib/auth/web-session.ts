import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import type { Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"

import { registerProcessCleanup } from "~/lib/process-cleanup"
import { PATHS } from "~/lib/storage/paths"
import { SqliteDbStore, type SqliteDatabase } from "~/lib/storage/sqlite"

export const WEB_SESSION_COOKIE = "copi_session"
export const WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const WEB_SESSION_TTL_MS = WEB_SESSION_TTL_SECONDS * 1000
const DEFAULT_ALLOWED_EMAIL = "bkg@eysho.info"

type UserRow = {
  id: number
  email: string
  password_hash: string
  created_at_ms: number
  last_login_ms: number | null
}

type SessionRow = {
  id: number
  email: string
  expires_at_ms: number
}

export type WebAuthUser = {
  id: number
  email: string
}

export class WebAuthError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "WebAuthError"
    this.status = status
    this.code = code
  }
}

export function initializeWebAuthDatabase(db: SqliteDatabase): void {
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_auth_users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      last_login_ms INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES web_auth_users(id) ON DELETE CASCADE,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      user_agent TEXT NOT NULL DEFAULT ''
    )
  `)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_web_auth_sessions_expiry ON web_auth_sessions(expires_at_ms)",
  )
}

function digestSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  })
}

async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(password, passwordHash)
  } catch {
    return false
  }
}

export interface WebAuthServiceOptions {
  getDb: () => Promise<SqliteDatabase>
  allowedEmail?: string
  now?: () => number
}

export function createWebAuthService(options: WebAuthServiceOptions) {
  const allowedEmail = (options.allowedEmail ?? DEFAULT_ALLOWED_EMAIL)
    .trim()
    .toLowerCase()
  const now = options.now ?? Date.now

  async function getUserRow(): Promise<UserRow | null> {
    const db = await options.getDb()
    return (
      db
        .prepare<UserRow>(
          "SELECT id, email, password_hash, created_at_ms, last_login_ms FROM web_auth_users WHERE id = 1",
        )
        .get() ?? null
    )
  }

  return {
    async status(): Promise<{ needsSetup: boolean }> {
      return { needsSetup: !(await getUserRow()) }
    },

    async register(
      emailInput: unknown,
      passwordInput: unknown,
    ): Promise<WebAuthUser> {
      const email =
        typeof emailInput === "string" ? emailInput.trim().toLowerCase() : ""
      const password = typeof passwordInput === "string" ? passwordInput : ""
      if (!email || !password) {
        throw new WebAuthError(
          "E-Mail und Passwort sind erforderlich.",
          400,
          "AUTH_CREDENTIALS_REQUIRED",
        )
      }
      if (email !== allowedEmail) {
        throw new WebAuthError(
          "Für diese Installation ist nur das freigegebene Administratorkonto zulässig.",
          403,
          "AUTH_EMAIL_NOT_ALLOWED",
        )
      }
      if (password.length < 12 || password.length > 1024) {
        throw new WebAuthError(
          "Das Passwort muss mindestens 12 Zeichen lang sein.",
          400,
          "AUTH_PASSWORD_TOO_SHORT",
        )
      }

      const db = await options.getDb()
      db.exec("BEGIN IMMEDIATE")
      try {
        const existing = db
          .prepare<{ id: number }>("SELECT id FROM web_auth_users LIMIT 1")
          .get()
        if (existing) {
          throw new WebAuthError(
            "Das Administratorkonto ist bereits eingerichtet. Bitte anmelden.",
            403,
            "AUTH_SETUP_ALREADY_COMPLETED",
          )
        }
        const passwordHash = await hashPassword(password)
        const timestamp = now()
        db.prepare(
          "INSERT INTO web_auth_users (id, email, password_hash, created_at_ms, last_login_ms) VALUES (1, ?, ?, ?, ?)",
        ).run(email, passwordHash, timestamp, timestamp)
        db.exec("COMMIT")
        return { id: 1, email }
      } catch (error) {
        try {
          db.exec("ROLLBACK")
        } catch {
          /* preserve the original error */
        }
        if (error instanceof WebAuthError) throw error
        throw new WebAuthError(
          "Das Administratorkonto konnte nicht angelegt werden.",
          500,
          "AUTH_REGISTER_FAILED",
        )
      }
    },

    async resetPassword(
      passwordInput: unknown,
    ): Promise<{ user: WebAuthUser; sessionsRevoked: number }> {
      const password = typeof passwordInput === "string" ? passwordInput : ""
      if (password.length < 12 || password.length > 1024) {
        throw new WebAuthError(
          "Das Passwort muss mindestens 12 Zeichen lang sein.",
          400,
          "AUTH_PASSWORD_TOO_SHORT",
        )
      }

      const db = await options.getDb()
      db.exec("BEGIN IMMEDIATE")
      try {
        const user = db
          .prepare<UserRow>(
            "SELECT id, email, password_hash, created_at_ms, last_login_ms FROM web_auth_users WHERE id = 1",
          )
          .get()
        if (!user) {
          throw new WebAuthError(
            "Das Administratorkonto ist nicht eingerichtet.",
            409,
            "AUTH_ACCOUNT_NOT_CONFIGURED",
          )
        }
        const passwordHash = await hashPassword(password)
        db.prepare(
          "UPDATE web_auth_users SET password_hash = ? WHERE id = 1",
        ).run(passwordHash)
        const sessionsRevoked = Number(
          db.prepare("DELETE FROM web_auth_sessions WHERE user_id = 1").run()
            .changes,
        )
        db.exec("COMMIT")
        return { user: { id: user.id, email: user.email }, sessionsRevoked }
      } catch (error) {
        try {
          db.exec("ROLLBACK")
        } catch {
          /* preserve the original error */
        }
        if (error instanceof WebAuthError) throw error
        throw new WebAuthError(
          "Das Administratorkonto konnte nicht zurückgesetzt werden.",
          500,
          "AUTH_PASSWORD_RESET_FAILED",
        )
      }
    },

    async login(
      emailInput: unknown,
      passwordInput: unknown,
    ): Promise<WebAuthUser> {
      const email =
        typeof emailInput === "string" ? emailInput.trim().toLowerCase() : ""
      const password = typeof passwordInput === "string" ? passwordInput : ""
      if (!email || !password || password.length > 1024) {
        throw new WebAuthError(
          "E-Mail oder Passwort ist ungültig.",
          401,
          "AUTH_INVALID_CREDENTIALS",
        )
      }
      const user = await getUserRow()
      const matches =
        user && user.email.toLowerCase() === email ?
          await verifyPassword(password, user.password_hash)
        : false
      if (!user || !matches) {
        throw new WebAuthError(
          "E-Mail oder Passwort ist falsch.",
          401,
          "AUTH_INVALID_CREDENTIALS",
        )
      }
      const db = await options.getDb()
      db.prepare(
        "UPDATE web_auth_users SET last_login_ms = ? WHERE id = 1",
      ).run(now())
      return { id: user.id, email: user.email }
    },

    async createSession(
      userAgent = "",
    ): Promise<{ token: string; expiresAt: number }> {
      const token = randomBytes(32).toString("base64url")
      const timestamp = now()
      const expiresAt = timestamp + WEB_SESSION_TTL_MS
      const db = await options.getDb()
      db.prepare("DELETE FROM web_auth_sessions WHERE expires_at_ms <= ?").run(
        timestamp,
      )
      db.prepare(
        "INSERT INTO web_auth_sessions (token_hash, user_id, created_at_ms, expires_at_ms, user_agent) VALUES (?, 1, ?, ?, ?)",
      ).run(
        digestSessionToken(token),
        timestamp,
        expiresAt,
        userAgent.slice(0, 512),
      )
      return { token, expiresAt }
    },

    async getSession(token: string | undefined): Promise<WebAuthUser | null> {
      if (!token || token.length < 32 || token.length > 128) return null
      const db = await options.getDb()
      const session = db
        .prepare<SessionRow>(
          `
        SELECT users.id, users.email, sessions.expires_at_ms
        FROM web_auth_sessions AS sessions
        JOIN web_auth_users AS users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at_ms > ?
      `,
        )
        .get(digestSessionToken(token), now())
      return session ? { id: session.id, email: session.email } : null
    },

    async revokeSession(token: string | undefined): Promise<void> {
      if (!token || token.length < 32 || token.length > 128) return
      const db = await options.getDb()
      db.prepare("DELETE FROM web_auth_sessions WHERE token_hash = ?").run(
        digestSessionToken(token),
      )
    },
  }
}

const authDbStore = new SqliteDbStore({
  getPath: () =>
    process.env.COPILOT_API_SQLITE_DB_PATH
    ?? path.join(PATHS.APP_DIR, "copilot-api.sqlite"),
  initialize: initializeWebAuthDatabase,
})

export const webAuthService = createWebAuthService({
  getDb: () => authDbStore.getDb(),
  allowedEmail: process.env.COPI_AUTH_EMAIL ?? DEFAULT_ALLOWED_EMAIL,
})

registerProcessCleanup(() => authDbStore.close())

export async function getWebAuthSession(
  c: Context,
): Promise<WebAuthUser | null> {
  return await webAuthService.getSession(getCookie(c, WEB_SESSION_COOKIE))
}

export function setWebAuthCookie(c: Context, token: string): void {
  const forwardedProto = c.req
    .header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase()
  const secure =
    new URL(c.req.url).protocol === "https:" || forwardedProto === "https"
  setCookie(c, WEB_SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/",
    maxAge: WEB_SESSION_TTL_SECONDS,
  })
}

export function clearWebAuthCookie(c: Context): void {
  const forwardedProto = c.req
    .header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase()
  const secure =
    new URL(c.req.url).protocol === "https:" || forwardedProto === "https"
  deleteCookie(c, WEB_SESSION_COOKIE, {
    httpOnly: true,
    secure,
    sameSite: "Strict",
    path: "/",
  })
}

export type WebAuthSessionLookup = (
  context: Context,
) => Promise<WebAuthUser | null>

export async function isDashboardSessionRequest(
  c: Context,
  lookup: WebAuthSessionLookup = getWebAuthSession,
): Promise<boolean> {
  const path = c.req.path
  const method = c.req.method.toUpperCase()
  const isUsageRead =
    method === "GET"
    && (/^\/usage(?:\/|$)/u.test(path)
      || /^\/token-usage(?:\/|$)/u.test(path)
      || path === "/models"
      || path === "/v1/models"
      || /^\/admin\/(?:usage|token-usage|api-keys\/usage)(?:\/|$)/u.test(path))
  const isApiKeyAdmin =
    /^\/admin\/api-keys(?:\/|$)/u.test(path)
    && ["GET", "POST", "PATCH", "DELETE"].includes(method)
  const isProviderAdmin =
    /^\/admin\/config\/providers(?:\/|$)/u.test(path)
    && ["GET", "POST", "PATCH", "DELETE"].includes(method)
  const isProviderAuth =
    /^\/auth\/providers(?:\/|$)/u.test(path) && ["GET", "POST"].includes(method)
  const isDashboardModelRequest =
    method === "POST"
    && ["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(path)
  if (
    !isUsageRead
    && !isApiKeyAdmin
    && !isProviderAdmin
    && !isProviderAuth
    && !isDashboardModelRequest
  ) {
    return false
  }
  return Boolean(await lookup(c))
}
