import { Hono, type Context } from "hono"
import { getCookie } from "hono/cookie"

import { createHandlerLogger } from "~/lib/logger"
import {
  clearWebAuthCookie,
  getWebAuthSession,
  setWebAuthCookie,
  WEB_SESSION_COOKIE,
  webAuthService,
  WebAuthError,
} from "~/lib/auth/web-session"

export const webAuthRoutes = new Hono()

const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 5
const RESET_WINDOW_MS = 15 * 60 * 1000
const RESET_MAX_CALLS = 5
let loginWindowStartedAt = 0
let loginFailureCount = 0
let resetWindowStartedAt = 0
let resetCallCount = 0

export const webAuthAdminLogger = createHandlerLogger("web-auth-admin")
// Audit-Ereignisse dürfen weder durch das globale Log-Level noch durch Throttling verloren gehen.
webAuthAdminLogger.level = 5
webAuthAdminLogger.options.throttle = 0

function errorResponse(
  error: unknown,
  fallbackCode = "INTERNAL_ERROR",
  fallbackMessage = "Authentifizierung fehlgeschlagen.",
) {
  if (error instanceof WebAuthError) {
    return {
      status: error.status,
      body: {
        success: false,
        error: { code: error.code, message: error.message },
      },
    }
  }
  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: fallbackCode,
        message: fallbackMessage,
      },
    },
  }
}

webAuthRoutes.get("/status", async (c) => {
  try {
    const [status, user] = await Promise.all([
      webAuthService.status(),
      getWebAuthSession(c),
    ])
    return c.json({ ...status, isAuthenticated: Boolean(user), user })
  } catch {
    return c.json(
      {
        success: false,
        error: {
          code: "AUTH_UNAVAILABLE",
          message: "Authentifizierung ist momentan nicht verfügbar.",
        },
      },
      503,
    )
  }
})

webAuthRoutes.post("/register", async (c) => {
  try {
    const body: unknown = await c.req.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          success: false,
          error: { code: "INVALID_REQUEST", message: "Ungültige Eingabe." },
        },
        400,
      )
    }
    const input = body as Record<string, unknown>
    const user = await webAuthService.register(input.email, input.password)
    const session = await webAuthService.createSession(
      c.req.header("user-agent") ?? "",
    )
    setWebAuthCookie(c, session.token)
    return c.json({ success: true, user })
  } catch (error) {
    const result = errorResponse(error)
    return c.json(result.body, result.status as 400 | 401 | 403 | 409 | 500)
  }
})

webAuthRoutes.post("/login", async (c) => {
  try {
    const body: unknown = await c.req.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          success: false,
          error: { code: "INVALID_REQUEST", message: "Ungültige Eingabe." },
        },
        400,
      )
    }
    const input = body as Record<string, unknown>
    const timestamp = Date.now()
    if (timestamp - loginWindowStartedAt >= LOGIN_WINDOW_MS) {
      loginWindowStartedAt = timestamp
      loginFailureCount = 0
    }
    if (loginFailureCount >= LOGIN_MAX_FAILURES) {
      return c.json(
        {
          success: false,
          error: {
            code: "AUTH_RATE_LIMITED",
            message:
              "Zu viele fehlgeschlagene Anmeldungen. Bitte später erneut versuchen.",
          },
        },
        429,
      )
    }
    let user
    try {
      user = await webAuthService.login(input.email, input.password)
    } catch (error) {
      loginFailureCount += 1
      throw error
    }
    loginFailureCount = 0
    const session = await webAuthService.createSession(
      c.req.header("user-agent") ?? "",
    )
    setWebAuthCookie(c, session.token)
    return c.json({ success: true, user })
  } catch (error) {
    const result = errorResponse(error)
    return c.json(result.body, result.status as 400 | 401 | 403 | 409 | 500)
  }
})

webAuthRoutes.post("/logout", async (c) => {
  await webAuthService.revokeSession(getCookie(c, WEB_SESSION_COOKIE))
  clearWebAuthCookie(c)
  return c.json({ success: true })
})

export const webAuthAdminRoutes = new Hono()

function auditPasswordReset(
  outcome: "success" | "failure",
  code: string,
  sessionsRevoked: number,
): void {
  webAuthAdminLogger.info(
    `event=password_reset outcome=${outcome} code=${code} sessionsRevoked=${sessionsRevoked}`,
  )
}

function invalidResetRequest(c: Context) {
  auditPasswordReset("failure", "INVALID_REQUEST", 0)
  return c.json(
    {
      success: false,
      error: { code: "INVALID_REQUEST", message: "Ungültige Eingabe." },
    },
    400,
  )
}

webAuthAdminRoutes.post("/reset-password", async (c) => {
  const timestamp = Date.now()
  if (timestamp - resetWindowStartedAt >= RESET_WINDOW_MS) {
    resetWindowStartedAt = timestamp
    resetCallCount = 0
  }
  if (resetCallCount >= RESET_MAX_CALLS) {
    auditPasswordReset("failure", "AUTH_RATE_LIMITED", 0)
    return c.json(
      {
        success: false,
        error: {
          code: "AUTH_RATE_LIMITED",
          message:
            "Zu viele Passwort-Reset-Versuche. Bitte später erneut versuchen.",
        },
      },
      429,
    )
  }
  resetCallCount += 1

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return invalidResetRequest(c)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalidResetRequest(c)
  }
  const input = body as Record<string, unknown>
  if (
    Object.keys(input).length !== 1
    || !Object.hasOwn(input, "password")
    || typeof input.password !== "string"
  ) {
    return invalidResetRequest(c)
  }

  try {
    const { user, sessionsRevoked } = await webAuthService.resetPassword(
      input.password,
    )
    loginWindowStartedAt = 0
    loginFailureCount = 0
    clearWebAuthCookie(c)
    auditPasswordReset("success", "AUTH_PASSWORD_RESET_OK", sessionsRevoked)
    return c.json({ success: true, user, sessionsRevoked })
  } catch (error) {
    const result = errorResponse(
      error,
      "AUTH_PASSWORD_RESET_FAILED",
      "Das Administratorkonto konnte nicht zurückgesetzt werden.",
    )
    auditPasswordReset("failure", result.body.error.code, 0)
    return c.json(
      result.body,
      result.status as 400 | 401 | 403 | 409 | 429 | 500,
    )
  }
})
