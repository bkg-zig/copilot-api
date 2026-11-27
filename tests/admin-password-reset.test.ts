import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"
import fs from "node:fs"
import path from "node:path"

import * as config from "~/lib/config"
import type { AppConfig } from "~/lib/types/config"
import {
  initializeWebAuthDatabase,
  webAuthService,
  WebAuthError,
} from "~/lib/auth/web-session"
import { openSqliteDatabase, type SqliteDatabase } from "~/lib/storage/sqlite"
import { webAuthAdminLogger } from "~/routes/auth/route"
import { createServer } from "~/server"

const originalDbPath = process.env.COPILOT_API_SQLITE_DB_PATH
const dbDir = fs.mkdtempSync(path.join("/tmp/opencode", "copi-admin-reset-"))
const dbPath = path.join(dbDir, "auth.sqlite")
process.env.COPILOT_API_SQLITE_DB_PATH = dbPath

type ConfigSpy = ReturnType<typeof spyOn<typeof config, "getConfig">>

const originalReporters = [...(webAuthAdminLogger.options.reporters ?? [])]
const auditLines: Array<string> = []
let configSpy: ConfigSpy | undefined
let nowMs = 1_800_000_000_000

function configure(
  adminApiKey?: string,
  apiKeys: Array<string> = ["regular-key"],
) {
  configSpy?.mockRestore()
  configSpy = spyOn(config, "getConfig").mockReturnValue({
    auth: {
      adminApiKey,
      apiKeyConfigs: apiKeys.map((key) => ({ id: key, key })),
    },
  } as AppConfig)
}

async function withAuthDb<T>(fn: (db: SqliteDatabase) => T): Promise<T> {
  const db = await openSqliteDatabase(dbPath)
  try {
    initializeWebAuthDatabase(db)
    return fn(db)
  } finally {
    db.close?.()
  }
}

async function clearAuthDatabase(): Promise<void> {
  await withAuthDb((db) => {
    db.exec("DELETE FROM web_auth_sessions")
    db.exec("DELETE FROM web_auth_users")
  })
}

async function prepareUser(
  password = "a-strong-password-for-copi",
): Promise<void> {
  await clearAuthDatabase()
  await webAuthService.register("bkg@eysho.info", password)
}

async function readPasswordHash(): Promise<string | undefined> {
  return await withAuthDb(
    (db) =>
      db
        .prepare<{
          password_hash: string
        }>("SELECT password_hash FROM web_auth_users WHERE id = 1")
        .get()?.password_hash,
  )
}

type App = ReturnType<typeof createServer>

async function resetRequest(
  app: App,
  headers: Record<string, string> = { "x-api-key": "admin-key" },
  body: unknown = { password: "a-new-strong-password" },
): Promise<Response> {
  return await app.request("/admin/auth/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function loginRequest(app: App, password: string): Promise<Response> {
  return await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "bkg@eysho.info", password }),
  })
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? ""
}

beforeEach(() => {
  nowMs += 20 * 60 * 1000
  setSystemTime(new Date(nowMs))
  auditLines.length = 0
  webAuthAdminLogger.setReporters([
    {
      log(logObj) {
        auditLines.push(logObj.args.map((arg) => String(arg)).join(" "))
      },
    },
  ])
  configure("admin-key")
})

afterEach(() => {
  webAuthAdminLogger.setReporters(originalReporters)
  configSpy?.mockRestore()
  configSpy = undefined
  setSystemTime()
})

afterAll(() => {
  if (originalDbPath === undefined) {
    Reflect.deleteProperty(process.env, "COPILOT_API_SQLITE_DB_PATH")
  } else {
    process.env.COPILOT_API_SQLITE_DB_PATH = originalDbPath
  }
  fs.rmSync(dbDir, { recursive: true, force: true })
})

test("requires the admin API key and never accepts a regular key or a web session", async () => {
  await prepareUser()
  const session = await webAuthService.createSession("founder-browser")
  const app = createServer()
  const unauthorized = async (headers: Record<string, string>) => {
    const response = await resetRequest(app, headers)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Bearer")
  }

  await unauthorized({})
  await unauthorized({ "x-api-key": "wrong-key" })
  await unauthorized({ "x-api-key": "regular-key" })
  await unauthorized({ cookie: `copi_session=${session.token}` })

  configure(undefined, ["regular-key"])
  await unauthorized({ "x-api-key": "regular-key" })
  expect(auditLines).toEqual([])
})

test("resets the password with x-api-key, clears the session cookie and leaks no secrets", async () => {
  await prepareUser()
  const session = await webAuthService.createSession("founder-browser")
  const oldHash = await readPasswordHash()
  expect(oldHash).toBeDefined()
  const newPassword = "a-brand-new-strong-password"
  const response = await resetRequest(
    createServer(),
    {
      "x-api-key": "admin-key",
    },
    { password: newPassword },
  )

  expect(response.status).toBe(200)
  const bodyText = await response.text()
  const body = JSON.parse(bodyText) as {
    success: boolean
    user: { id: number; email: string }
    sessionsRevoked: number
  }
  expect(body).toEqual({
    success: true,
    user: { id: 1, email: "bkg@eysho.info" },
    sessionsRevoked: 1,
  })
  expect(response.headers.get("set-cookie")).toContain("copi_session=")
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0")
  expect(bodyText).not.toContain(newPassword)
  expect(bodyText).not.toContain(String(oldHash))
  expect(bodyText).not.toContain("admin-key")
  expect(bodyText).not.toContain(session.token)
  expect(await webAuthService.getSession(session.token)).toBeNull()
  expect(await readPasswordHash()).not.toBe(oldHash)
  expect(await webAuthService.login("bkg@eysho.info", newPassword)).toEqual({
    id: 1,
    email: "bkg@eysho.info",
  })

  expect(auditLines).toHaveLength(1)
  expect(auditLines[0]).toContain("event=password_reset")
  expect(auditLines[0]).toContain("outcome=success")
  expect(auditLines[0]).toContain("code=AUTH_PASSWORD_RESET_OK")
  expect(auditLines[0]).toContain("sessionsRevoked=1")
  expect(auditLines[0]).not.toContain(newPassword)
  expect(auditLines[0]).not.toContain(String(oldHash))
  expect(auditLines[0]).not.toContain("admin-key")
  expect(auditLines[0]).not.toContain(session.token)
})

test("accepts the admin key through Authorization Bearer", async () => {
  await prepareUser()
  const response = await resetRequest(createServer(), {
    authorization: "Bearer admin-key",
  })

  expect(response.status).toBe(200)
  const body = (await response.json()) as { sessionsRevoked: number }
  expect(body.sessionsRevoked).toBe(0)
  expect(response.headers.get("set-cookie")).toContain("copi_session=")
})

test("rejects malformed JSON and unexpected fields with INVALID_REQUEST", async () => {
  await prepareUser()
  const originalHash = await readPasswordHash()
  const app = createServer()
  const cases: Array<unknown> = [
    "{",
    [],
    null,
    { password: "a-new-strong-password", email: "attacker@example.com" },
    {},
    { password: 1234 },
  ]

  for (const [index, body] of cases.entries()) {
    if (index === 5) {
      nowMs += 20 * 60 * 1000
      setSystemTime(new Date(nowMs))
    }
    const response = await resetRequest(app, undefined, body)
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe("INVALID_REQUEST")
  }
  expect(await readPasswordHash()).toBe(originalHash)
  expect(auditLines).toHaveLength(6)
  expect(
    auditLines.every((line) => line.includes("code=INVALID_REQUEST")),
  ).toBe(true)
})

test("rejects too short and too long passwords", async () => {
  await prepareUser()
  const app = createServer()

  const short = await resetRequest(app, undefined, { password: "too-short" })
  expect(short.status).toBe(400)
  expect(await errorCode(short)).toBe("AUTH_PASSWORD_TOO_SHORT")

  const long = await resetRequest(app, undefined, {
    password: "x".repeat(1025),
  })
  expect(long.status).toBe(400)
  expect(await errorCode(long)).toBe("AUTH_PASSWORD_TOO_SHORT")
})

test("reports a missing account as 409 before setup", async () => {
  await clearAuthDatabase()
  const response = await resetRequest(createServer())

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    success: false,
    error: {
      code: "AUTH_ACCOUNT_NOT_CONFIGURED",
      message: "Das Administratorkonto ist nicht eingerichtet.",
    },
  })
  expect(auditLines[0]).toContain("code=AUTH_ACCOUNT_NOT_CONFIGURED")
})

test("limits authenticated calls to five per window and does not reset the counter on success", async () => {
  await prepareUser()
  const app = createServer()

  const success = await resetRequest(app)
  expect(success.status).toBe(200)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await resetRequest(app, undefined, {
      password: "too-short",
    })
    expect(response.status).toBe(400)
  }
  const limited = await resetRequest(app)
  expect(limited.status).toBe(429)
  expect(await errorCode(limited)).toBe("AUTH_RATE_LIMITED")
  expect(
    auditLines.filter((line) => line.includes("outcome=success")),
  ).toHaveLength(1)

  nowMs += 20 * 60 * 1000
  setSystemTime(new Date(nowMs))
  const afterWindow = await resetRequest(app, undefined, {
    password: "too-short",
  })
  expect(afterWindow.status).toBe(400)
})

test("returns AUTH_PASSWORD_RESET_FAILED without leaking the underlying error", async () => {
  await prepareUser()
  const resetSpy = spyOn(webAuthService, "resetPassword").mockRejectedValue(
    new WebAuthError(
      "Das Administratorkonto konnte nicht zurückgesetzt werden.",
      500,
      "AUTH_PASSWORD_RESET_FAILED",
    ),
  )
  try {
    const response = await resetRequest(createServer())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "AUTH_PASSWORD_RESET_FAILED",
        message: "Das Administratorkonto konnte nicht zurückgesetzt werden.",
      },
    })
    expect(auditLines[0]).toContain("code=AUTH_PASSWORD_RESET_FAILED")

    resetSpy.mockRejectedValue(new Error("interner details"))
    const generic = await resetRequest(createServer())
    const genericText = await generic.text()
    expect(generic.status).toBe(500)
    expect(genericText).not.toContain("interner details")
    const genericBody = JSON.parse(genericText) as { error: { code: string } }
    expect(genericBody.error.code).toBe("AUTH_PASSWORD_RESET_FAILED")
  } finally {
    resetSpy.mockRestore()
  }
})

test("a successful reset clears the login failure window", async () => {
  await prepareUser()
  const app = createServer()

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await loginRequest(app, "wrong-password")
    expect(response.status).toBe(401)
  }
  const blocked = await loginRequest(app, "a-strong-password-for-copi")
  expect(blocked.status).toBe(429)

  const reset = await resetRequest(app)
  expect(reset.status).toBe(200)

  const unlocked = await loginRequest(app, "a-new-strong-password")
  expect(unlocked.status).toBe(200)
})

test("denies cross-origin CORS preflight for the admin reset route", async () => {
  const response = await createServer({ networkExposed: true }).request(
    "https://copi.example/admin/auth/reset-password",
    {
      method: "OPTIONS",
      headers: {
        origin: "https://attacker.example.com",
        "access-control-request-method": "POST",
      },
    },
  )

  expect(response.headers.has("access-control-allow-origin")).toBe(false)
  expect(auditLines).toEqual([])
})
