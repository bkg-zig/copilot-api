import { createHash, randomBytes } from "node:crypto"
import path from "node:path"

import { PATHS } from "./paths"
import { SqliteDbStore, type SqliteDatabase } from "./sqlite"

export type UserRole = "admin" | "user"
export type EmailTokenPurpose = "setup" | "invite" | "reset"

export interface PublicUser {
  email: string
  role: UserRole
  hasPassword: boolean
  createdAt: string
  updatedAt: string
}

export interface Session {
  email: string
  role: UserRole
  expiresAt: number
}

export interface EmailToken {
  email: string
  purpose: EmailTokenPurpose
  role: UserRole | null
  expiresAt: number
}

export class UserStoreError extends Error {
  readonly status: 400 | 404 | 409

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.name = "UserStoreError"
    this.status = status
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 10
const MAX_PASSWORD_LENGTH = 256
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000
const TOKEN_BYTES = 32

export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  setup: 30 * 60 * 1000,
  invite: 7 * 24 * 60 * 60 * 1000,
  reset: 30 * 60 * 1000,
}

// Verifying against a fixed hash when the user does not exist keeps the
// response time of "unknown user" and "wrong password" indistinguishable.
let dummyHash: Promise<string> | undefined
const getDummyHash = (): Promise<string> => {
  dummyHash ??= Bun.password.hash(randomBytes(16).toString("hex"))
  return dummyHash
}

export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") {
    throw new UserStoreError("Enter a valid email address.")
  }
  const value = email.trim().toLowerCase()
  if (value.length > 254 || !EMAIL_PATTERN.test(value)) {
    throw new UserStoreError("Enter a valid email address.")
  }
  return value
}

export function validatePassword(password: unknown): string {
  if (
    typeof password !== "string"
    || password.length < MIN_PASSWORD_LENGTH
    || password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new UserStoreError(
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters long.`,
    )
  }
  return password
}

export function validateRole(role: unknown): UserRole {
  if (role === "admin" || role === "user") return role
  throw new UserStoreError("Role must be 'admin' or 'user'.")
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex")

const newToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url")

interface UserRow {
  email: string
  role: UserRole
  password_hash: string | null
  created_at: string
  updated_at: string
}

const toPublicUser = (row: UserRow): PublicUser => ({
  email: row.email,
  role: row.role,
  hasPassword: Boolean(row.password_hash),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export function initializeUserTables(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_users (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      password_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dashboard_sessions (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES dashboard_users(email) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dashboard_sessions_email ON dashboard_sessions(email);
    CREATE TABLE IF NOT EXISTS dashboard_email_tokens (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'invite', 'reset')),
      role TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dashboard_login_failures (
      client_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    );
  `)
}

export class UserStore {
  private readonly getDb: () => Promise<SqliteDatabase>
  private readonly now: () => number

  constructor(
    getDb: () => Promise<SqliteDatabase>,
    now: () => number = Date.now,
  ) {
    this.getDb = getDb
    this.now = now
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private async row(email: string): Promise<UserRow | undefined> {
    const db = await this.getDb()
    return db
      .prepare("SELECT * FROM dashboard_users WHERE email = ?")
      .get(email) as UserRow | undefined
  }

  async hasUsers(): Promise<boolean> {
    const db = await this.getDb()
    return Boolean(db.prepare("SELECT 1 FROM dashboard_users LIMIT 1").get())
  }

  async listUsers(): Promise<Array<PublicUser>> {
    const db = await this.getDb()
    const rows = db
      .prepare<UserRow>(
        "SELECT * FROM dashboard_users ORDER BY created_at, email",
      )
      .all()
    return rows.map((row) => toPublicUser(row))
  }

  async getUser(email: string): Promise<PublicUser | undefined> {
    const row = await this.row(email)
    return row ? toPublicUser(row) : undefined
  }

  /** Creates a user; without a password the account waits for its email link. */
  async createUser(
    email: unknown,
    password: unknown,
    role: unknown,
  ): Promise<PublicUser> {
    const address = normalizeEmail(email)
    const userRole = validateRole(role)
    const passwordHash =
      password === undefined || password === null || password === "" ?
        null
      : await Bun.password.hash(validatePassword(password))
    if (await this.row(address)) {
      throw new UserStoreError(`User '${address}' already exists.`, 409)
    }
    const db = await this.getDb()
    const timestamp = this.iso()
    db.prepare(
      "INSERT INTO dashboard_users (email, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(address, userRole, passwordHash, timestamp, timestamp)
    return (await this.getUser(address)) as PublicUser
  }

  async setPassword(email: string, password: unknown): Promise<PublicUser> {
    const passwordHash = await Bun.password.hash(validatePassword(password))
    const row = await this.row(email)
    if (!row) throw new UserStoreError(`User '${email}' not found.`, 404)
    const db = await this.getDb()
    db.prepare(
      "UPDATE dashboard_users SET password_hash = ?, updated_at = ? WHERE email = ?",
    ).run(passwordHash, this.iso(), email)
    // A new password ends every existing session of this account.
    await this.revokeSessionsFor(email)
    return (await this.getUser(email)) as PublicUser
  }

  async setRole(email: string, role: unknown): Promise<PublicUser> {
    const userRole = validateRole(role)
    const row = await this.row(email)
    if (!row) throw new UserStoreError(`User '${email}' not found.`, 404)
    if (row.role === "admin" && userRole !== "admin") {
      await this.assertAnotherAdmin(email)
    }
    const db = await this.getDb()
    db.prepare(
      "UPDATE dashboard_users SET role = ?, updated_at = ? WHERE email = ?",
    ).run(userRole, this.iso(), email)
    return (await this.getUser(email)) as PublicUser
  }

  async deleteUser(email: string): Promise<void> {
    const row = await this.row(email)
    if (!row) throw new UserStoreError(`User '${email}' not found.`, 404)
    if (row.role === "admin") await this.assertAnotherAdmin(email)
    const db = await this.getDb()
    db.prepare("DELETE FROM dashboard_sessions WHERE email = ?").run(email)
    db.prepare("DELETE FROM dashboard_email_tokens WHERE email = ?").run(email)
    db.prepare("DELETE FROM dashboard_users WHERE email = ?").run(email)
  }

  private async assertAnotherAdmin(email: string): Promise<void> {
    const db = await this.getDb()
    const other = db
      .prepare(
        "SELECT 1 FROM dashboard_users WHERE role = 'admin' AND email != ? LIMIT 1",
      )
      .get(email)
    if (!other) {
      throw new UserStoreError("At least one admin account must remain.", 409)
    }
  }

  async verifyCredentials(
    email: unknown,
    password: unknown,
  ): Promise<PublicUser | null> {
    if (typeof email !== "string" || typeof password !== "string") return null
    const row = await this.row(email.trim().toLowerCase())
    const valid = await Bun.password.verify(
      password,
      row?.password_hash ?? (await getDummyHash()),
    )
    return row?.password_hash && valid ? toPublicUser(row) : null
  }

  // --- Sessions ---

  async createSession(email: string): Promise<string> {
    const db = await this.getDb()
    const now = this.now()
    db.prepare("DELETE FROM dashboard_sessions WHERE expires_at <= ?").run(now)
    const token = newToken()
    db.prepare(
      "INSERT INTO dashboard_sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(hashToken(token), email, now, now + SESSION_TTL_MS)
    return token
  }

  async getSession(token: string | undefined): Promise<Session | null> {
    if (!token) return null
    const db = await this.getDb()
    const row = db
      .prepare(
        `SELECT s.email AS email, u.role AS role, s.expires_at AS expires_at
         FROM dashboard_sessions s JOIN dashboard_users u ON u.email = s.email
         WHERE s.token_hash = ?`,
      )
      .get(hashToken(token)) as
      | { email: string; role: UserRole; expires_at: number }
      | undefined
    if (!row) return null
    if (row.expires_at <= this.now()) {
      db.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?").run(
        hashToken(token),
      )
      return null
    }
    // Role comes from the user row, so role changes apply immediately.
    return { email: row.email, role: row.role, expiresAt: row.expires_at }
  }

  async destroySession(token: string | undefined): Promise<void> {
    if (!token) return
    const db = await this.getDb()
    db.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?").run(
      hashToken(token),
    )
  }

  async revokeSessionsFor(email: string): Promise<void> {
    const db = await this.getDb()
    db.prepare("DELETE FROM dashboard_sessions WHERE email = ?").run(email)
  }

  // --- One-time email links (setup, invitation, password reset) ---

  async createEmailToken(
    email: string,
    purpose: EmailTokenPurpose,
    role: UserRole | null = null,
  ): Promise<string> {
    const db = await this.getDb()
    const now = this.now()
    db.prepare("DELETE FROM dashboard_email_tokens WHERE expires_at <= ?").run(
      now,
    )
    // Only the newest link per address and purpose stays valid.
    db.prepare(
      "DELETE FROM dashboard_email_tokens WHERE email = ? AND purpose = ?",
    ).run(email, purpose)
    const token = newToken()
    db.prepare(
      "INSERT INTO dashboard_email_tokens (token_hash, email, purpose, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      hashToken(token),
      email,
      purpose,
      role,
      now,
      now + EMAIL_TOKEN_TTL_MS[purpose],
    )
    return token
  }

  async peekEmailToken(token: unknown): Promise<EmailToken | null> {
    if (typeof token !== "string" || !token) return null
    const db = await this.getDb()
    const row = db
      .prepare(
        "SELECT email, purpose, role, expires_at FROM dashboard_email_tokens WHERE token_hash = ?",
      )
      .get(hashToken(token)) as
      | {
          email: string
          purpose: EmailTokenPurpose
          role: UserRole | null
          expires_at: number
        }
      | undefined
    if (!row || row.expires_at <= this.now()) return null
    return {
      email: row.email,
      purpose: row.purpose,
      role: row.role,
      expiresAt: row.expires_at,
    }
  }

  async consumeEmailToken(token: string): Promise<void> {
    const db = await this.getDb()
    db.prepare("DELETE FROM dashboard_email_tokens WHERE token_hash = ?").run(
      hashToken(token),
    )
  }

  // --- Failed-login limiter (fixed window per client) ---

  async isLoginBlocked(
    key: string,
    maxFailures = 10,
    windowMs = 15 * 60 * 1000,
  ): Promise<boolean> {
    const db = await this.getDb()
    const row = db
      .prepare(
        "SELECT count, window_start FROM dashboard_login_failures WHERE client_key = ?",
      )
      .get(key) as { count: number; window_start: number } | undefined
    if (!row) return false
    if (this.now() - row.window_start >= windowMs) {
      db.prepare(
        "DELETE FROM dashboard_login_failures WHERE client_key = ?",
      ).run(key)
      return false
    }
    return row.count >= maxFailures
  }

  async recordLoginFailure(
    key: string,
    windowMs = 15 * 60 * 1000,
  ): Promise<void> {
    const db = await this.getDb()
    const now = this.now()
    db.prepare(
      "DELETE FROM dashboard_login_failures WHERE window_start <= ?",
    ).run(now - windowMs)
    db.prepare(
      `INSERT INTO dashboard_login_failures (client_key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(client_key) DO UPDATE SET count = count + 1`,
    ).run(key, now)
  }

  async resetLoginFailures(key: string): Promise<void> {
    const db = await this.getDb()
    db.prepare("DELETE FROM dashboard_login_failures WHERE client_key = ?").run(
      key,
    )
  }
}

function getDbPath(): string {
  return (
    process.env.COPILOT_API_SQLITE_DB_PATH
    ?? path.join(PATHS.APP_DIR, "copilot-api.sqlite")
  )
}

const userDbStore = new SqliteDbStore({
  getPath: getDbPath,
  initialize: initializeUserTables,
})

let defaultStore: UserStore | undefined

export function getUserStore(): UserStore {
  defaultStore ??= new UserStore(() => userDbStore.getDb())
  return defaultStore
}

export function setUserStoreForTesting(store: UserStore | undefined): void {
  defaultStore = store
}
