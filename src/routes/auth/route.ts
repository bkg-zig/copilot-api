import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"
import { Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"

import { getMailSender } from "~/lib/mailer"
import {
  extractRequestApiKey,
  getConfiguredAdminApiKeys,
} from "~/lib/request-auth"
import {
  getUserStore,
  normalizeEmail,
  SESSION_MAX_AGE_SECONDS,
  UserStoreError,
  type EmailTokenPurpose,
  type Session,
  type UserRole,
} from "~/lib/users"

export const SESSION_COOKIE_NAME = "cpa_session"
const SETUP_MAIL_COOLDOWN_MS = 60_000
let lastSetupMailAt = 0

export function resetAuthRouteStateForTesting(): void {
  lastSetupMailAt = 0
}

export async function getRequestSession(c: Context): Promise<Session | null> {
  return getUserStore().getSession(getCookie(c, SESSION_COOKIE_NAME))
}

function getAdminEmail(): string | null {
  const raw = process.env.COPILOT_API_ADMIN_EMAIL?.trim()
  if (!raw) return null
  try {
    return normalizeEmail(raw)
  } catch {
    consola.warn("COPILOT_API_ADMIN_EMAIL is not a valid email address.")
    return null
  }
}

/** b***@gitspit.com — enough to recognise the address, not to harvest it. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@")
  return `${local.slice(0, 1)}***@${domain}`
}

/**
 * Base URL for links in emails. Never derived from the Host header alone, or
 * a forged request could make the gateway mail links to a foreign domain.
 */
function getPublicUrl(): string | null {
  const explicit = process.env.COPILOT_API_PUBLIC_URL?.trim()
  const fallback =
    process.env.COPILOT_API_ALLOWED_ORIGINS?.split(",")[0]?.trim()
  const value = explicit || fallback
  if (!value) return null
  try {
    const url = new URL(value)
    return url.origin
  } catch {
    return null
  }
}

function isHttpsRequest(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]
  if (forwardedProto) return forwardedProto.trim().toLowerCase() === "https"
  return new URL(c.req.url).protocol === "https:"
}

function getClientKey(c: Context): string {
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
  return forwardedFor || c.req.header("x-real-ip") || "direct"
}

function errorResponse(
  c: Context,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
  type = "invalid_request_error",
): Response {
  return c.json({ error: { message, type } }, status)
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return body && typeof body === "object" ?
        (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function handleStoreError(c: Context, error: unknown): Response {
  if (error instanceof UserStoreError) {
    return errorResponse(c, error.message, error.status)
  }
  throw error
}

async function startSession(
  c: Context,
  email: string,
  role: UserRole,
): Promise<Response> {
  const token = await getUserStore().createSession(email)
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttpsRequest(c),
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
  return c.json({ user: { email, role } })
}

const MAIL_TEXT: Record<
  EmailTokenPurpose,
  { subject: string; intro: string; action: string; validity: string }
> = {
  setup: {
    subject: "Copilot API: set up your admin account",
    intro:
      "Someone (hopefully you) asked to set up the first admin account of the Copilot API dashboard.",
    action: "Open this link to choose your password:",
    validity: "The link works once and expires in 30 minutes.",
  },
  invite: {
    subject: "Copilot API: you have been invited",
    intro: "You have been invited to the Copilot API dashboard.",
    action: "Open this link to choose your password:",
    validity: "The link works once and expires in 7 days.",
  },
  reset: {
    subject: "Copilot API: reset your password",
    intro:
      "Someone asked to reset the password of your Copilot API dashboard account.",
    action: "Open this link to choose a new password:",
    validity:
      "The link works once and expires in 30 minutes. If you did not ask for this, ignore this email.",
  },
}

/** Creates a one-time link and mails it. Returns false when mail is not set up. */
async function sendEmailLink(
  email: string,
  purpose: EmailTokenPurpose,
  role: UserRole | null = null,
): Promise<boolean> {
  const send = getMailSender()
  const publicUrl = getPublicUrl()
  if (!send || !publicUrl) return false
  const token = await getUserStore().createEmailToken(email, purpose, role)
  const link = `${publicUrl}/?auth_token=${encodeURIComponent(token)}`
  const text = MAIL_TEXT[purpose]
  await send({
    to: email,
    subject: text.subject,
    text: `${text.intro}\n\n${text.action}\n${link}\n\n${text.validity}\n`,
  })
  return true
}

function isMailReady(): boolean {
  return Boolean(getMailSender() && getPublicUrl())
}

export const authRoutes = new Hono()

authRoutes.get("/status", async (c) => {
  const store = getUserStore()
  const session = await getRequestSession(c)
  const adminEmail = getAdminEmail()
  return c.json({
    setupRequired: !(await store.hasUsers()),
    setupByEmail: Boolean(adminEmail && isMailReady()),
    setupEmailHint: adminEmail ? maskEmail(adminEmail) : null,
    setupNeedsAdminKey: getConfiguredAdminApiKeys().length > 0,
    passwordResetAvailable: isMailReady(),
    user: session ? { email: session.email, role: session.role } : null,
  })
})

// First admin, preferred way: a one-time link to COPILOT_API_ADMIN_EMAIL. Only
// that address can receive it, so nobody on the network can claim the instance.
authRoutes.post("/setup/request", async (c) => {
  const store = getUserStore()
  if (await store.hasUsers()) {
    return errorResponse(c, "Setup is already complete.", 409)
  }
  const adminEmail = getAdminEmail()
  if (!adminEmail || !isMailReady()) {
    return errorResponse(
      c,
      "Email setup is not configured (COPILOT_API_ADMIN_EMAIL, COPILOT_API_SMTP_*, COPILOT_API_PUBLIC_URL).",
      503,
      "configuration_error",
    )
  }
  if (Date.now() - lastSetupMailAt < SETUP_MAIL_COOLDOWN_MS) {
    return errorResponse(
      c,
      "A setup link was just sent. Wait a minute before asking again.",
      429,
      "rate_limit_error",
    )
  }
  lastSetupMailAt = Date.now()
  try {
    await sendEmailLink(adminEmail, "setup", "admin")
  } catch (error) {
    lastSetupMailAt = 0
    consola.error("Could not send setup email:", error)
    return errorResponse(
      c,
      "Could not send the email. Check the mail settings.",
      503,
      "configuration_error",
    )
  }
  return c.json({ sent: true, to: maskEmail(adminEmail) })
})

// First admin, fallback without mail: the configured admin API key.
authRoutes.post("/setup", async (c) => {
  const store = getUserStore()
  if (await store.hasUsers()) {
    return errorResponse(c, "Setup is already complete.", 409)
  }
  const adminKeys = getConfiguredAdminApiKeys()
  if (adminKeys.length === 0) {
    return errorResponse(
      c,
      "No admin API key is configured. Use the email setup instead.",
      403,
      "permission_error",
    )
  }
  const body = await readJson(c)
  const providedKey =
    typeof body.adminKey === "string" ?
      body.adminKey.trim()
    : extractRequestApiKey(c)
  if (!providedKey || !adminKeys.includes(providedKey)) {
    return errorResponse(c, "Invalid admin key.", 401, "authentication_error")
  }
  try {
    const user = await store.createUser(body.email, body.password, "admin")
    consola.info(`Created initial admin account '${user.email}'.`)
    return await startSession(c, user.email, user.role)
  } catch (error) {
    return handleStoreError(c, error)
  }
})

// What an emailed link is for, so the page can show the right form.
authRoutes.post("/link/inspect", async (c) => {
  const body = await readJson(c)
  const token = await getUserStore().peekEmailToken(body.token)
  if (!token) {
    return errorResponse(c, "This link is invalid or has expired.", 404)
  }
  return c.json({ email: token.email, purpose: token.purpose })
})

// Sets the password from an emailed link and signs the user in.
authRoutes.post("/link/complete", async (c) => {
  const body = await readJson(c)
  const store = getUserStore()
  const tokenValue = typeof body.token === "string" ? body.token : ""
  const token = await store.peekEmailToken(tokenValue)
  if (!token) {
    return errorResponse(c, "This link is invalid or has expired.", 404)
  }
  try {
    let user = await store.getUser(token.email)
    if (token.purpose === "setup") {
      if (await store.hasUsers()) {
        await store.consumeEmailToken(tokenValue)
        return errorResponse(c, "Setup is already complete.", 409)
      }
      user = await store.createUser(token.email, body.password, "admin")
    } else if (!user) {
      await store.consumeEmailToken(tokenValue)
      return errorResponse(c, "This account no longer exists.", 404)
    } else {
      user = await store.setPassword(token.email, body.password)
    }
    await store.consumeEmailToken(tokenValue)
    return await startSession(c, user.email, user.role)
  } catch (error) {
    return handleStoreError(c, error)
  }
})

authRoutes.post("/login", async (c) => {
  const store = getUserStore()
  const clientKey = getClientKey(c)
  if (await store.isLoginBlocked(clientKey)) {
    return errorResponse(
      c,
      "Too many failed login attempts. Try again later.",
      429,
      "rate_limit_error",
    )
  }
  const body = await readJson(c)
  const user = await store.verifyCredentials(body.email, body.password)
  if (!user) {
    await store.recordLoginFailure(clientKey)
    return errorResponse(
      c,
      "Invalid email or password.",
      401,
      "authentication_error",
    )
  }
  await store.resetLoginFailures(clientKey)
  return startSession(c, user.email, user.role)
})

// Always answers the same way, so it cannot be used to probe for accounts.
authRoutes.post("/password/forgot", async (c) => {
  const body = await readJson(c)
  if (!isMailReady()) {
    return errorResponse(
      c,
      "Password reset by email is not configured.",
      503,
      "configuration_error",
    )
  }
  const store = getUserStore()
  const clientKey = `forgot:${getClientKey(c)}`
  if (await store.isLoginBlocked(clientKey, 5)) {
    return errorResponse(
      c,
      "Too many requests. Try again later.",
      429,
      "rate_limit_error",
    )
  }
  await store.recordLoginFailure(clientKey)
  try {
    const email = normalizeEmail(body.email)
    if (await store.getUser(email)) await sendEmailLink(email, "reset")
  } catch (error) {
    if (!(error instanceof UserStoreError)) {
      consola.error("Could not send password reset email:", error)
    }
  }
  return c.json({ ok: true })
})

authRoutes.post("/logout", async (c) => {
  await getUserStore().destroySession(getCookie(c, SESSION_COOKIE_NAME))
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" })
  return c.json({ ok: true })
})

authRoutes.get("/me", async (c) => {
  const session = await getRequestSession(c)
  if (!session) {
    return errorResponse(c, "Not logged in.", 401, "authentication_error")
  }
  return c.json({ user: { email: session.email, role: session.role } })
})

authRoutes.post("/password", async (c) => {
  const session = await getRequestSession(c)
  if (!session) {
    return errorResponse(c, "Not logged in.", 401, "authentication_error")
  }
  const body = await readJson(c)
  const store = getUserStore()
  const valid = await store.verifyCredentials(
    session.email,
    body.currentPassword,
  )
  if (!valid) {
    return errorResponse(
      c,
      "Current password is wrong.",
      401,
      "authentication_error",
    )
  }
  try {
    const user = await store.setPassword(session.email, body.newPassword)
    // setPassword ended all sessions of this user; keep the caller signed in.
    return await startSession(c, user.email, user.role)
  } catch (error) {
    return handleStoreError(c, error)
  }
})

// Password reset without a session, authorised by the configured admin API
// key. Intended for headless/ops use (curl, scripts) when email reset is not
// available or the only admin is locked out.
authRoutes.post("/password/reset-via-admin", async (c) => {
  const adminKeys = getConfiguredAdminApiKeys()
  if (adminKeys.length === 0) {
    return errorResponse(
      c,
      "No admin API key is configured. Sign in as an admin instead.",
      403,
      "permission_error",
    )
  }
  const body = await readJson(c)
  const providedKey =
    typeof body.adminKey === "string" && body.adminKey.trim() ?
      body.adminKey.trim()
    : extractRequestApiKey(c)
  if (!providedKey || !adminKeys.includes(providedKey)) {
    return errorResponse(c, "Invalid admin key.", 401, "authentication_error")
  }
  const store = getUserStore()
  const clientKey = `admin-reset:${getClientKey(c)}`
  if (await store.isLoginBlocked(clientKey, 10)) {
    return errorResponse(
      c,
      "Too many requests. Try again later.",
      429,
      "rate_limit_error",
    )
  }
  try {
    const email = normalizeEmail(body.email)
    if (!(await store.getUser(email))) {
      await store.recordLoginFailure(clientKey)
      return errorResponse(c, `User '${email}' not found.`, 404)
    }
    const user = await store.setPassword(email, body.password)
    await store.resetLoginFailures(clientKey)
    consola.info(`Password of '${user.email}' reset via admin key.`)
    return c.json({ user: { email: user.email, role: user.role } })
  } catch (error) {
    return handleStoreError(c, error)
  }
})

// --- Admin-only user management ---

const requireAdminSession: MiddlewareHandler = async (c, next) => {
  if ((await getRequestSession(c))?.role !== "admin") {
    return errorResponse(c, "Admin role required.", 403, "permission_error")
  }
  return next()
}

authRoutes.use("/users", requireAdminSession)
authRoutes.use("/users/*", requireAdminSession)

authRoutes.get("/users", async (c) =>
  c.json({ users: await getUserStore().listUsers(), mailReady: isMailReady() }),
)

// Invite by email; without mail the admin sets an initial password instead.
authRoutes.post("/users", async (c) => {
  const body = await readJson(c)
  const store = getUserStore()
  const mailReady = isMailReady()
  try {
    if (!mailReady && !body.password) {
      return errorResponse(
        c,
        "Email is not configured: enter an initial password.",
        400,
      )
    }
    const user = await store.createUser(
      body.email,
      mailReady ? undefined : body.password,
      body.role ?? "user",
    )
    let invited = false
    if (mailReady) {
      try {
        invited = await sendEmailLink(user.email, "invite", user.role)
      } catch (error) {
        consola.error("Could not send invitation email:", error)
      }
    }
    return c.json({ user, invited }, 201)
  } catch (error) {
    return handleStoreError(c, error)
  }
})

authRoutes.patch("/users/:email", async (c) => {
  const body = await readJson(c)
  const store = getUserStore()
  const email = decodeURIComponent(c.req.param("email")).toLowerCase()
  try {
    let user = await store.getUser(email)
    if (!user) return errorResponse(c, `User '${email}' not found.`, 404)
    if (body.role !== undefined) user = await store.setRole(email, body.role)
    if (body.password !== undefined) {
      user = await store.setPassword(email, body.password)
    }
    return c.json({ user })
  } catch (error) {
    return handleStoreError(c, error)
  }
})

// Sends a fresh reset (or invitation) link to the user.
authRoutes.post("/users/:email/send-link", async (c) => {
  const store = getUserStore()
  const email = decodeURIComponent(c.req.param("email")).toLowerCase()
  const user = await store.getUser(email)
  if (!user) return errorResponse(c, `User '${email}' not found.`, 404)
  if (!isMailReady()) {
    return errorResponse(
      c,
      "Email is not configured.",
      503,
      "configuration_error",
    )
  }
  try {
    await sendEmailLink(email, user.hasPassword ? "reset" : "invite", user.role)
  } catch (error) {
    consola.error("Could not send email link:", error)
    return errorResponse(
      c,
      "Could not send the email. Check the mail settings.",
      503,
      "configuration_error",
    )
  }
  return c.json({ sent: true })
})

authRoutes.delete("/users/:email", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase()
  if ((await getRequestSession(c))?.email === email) {
    return errorResponse(c, "You cannot delete your own account.", 400)
  }
  try {
    await getUserStore().deleteUser(email)
    return c.json({ ok: true })
  } catch (error) {
    return handleStoreError(c, error)
  }
})

/**
 * Seeds the first admin from COPILOT_API_ADMIN_EMAIL + COPILOT_API_ADMIN_PASSWORD
 * when no account exists yet (headless bootstrap without mail).
 */
export async function seedAdminFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const email = env.COPILOT_API_ADMIN_EMAIL?.trim()
  const password = env.COPILOT_API_ADMIN_PASSWORD
  if (!email || !password) return false
  const store = getUserStore()
  if (await store.hasUsers()) return false
  try {
    await store.createUser(email, password, "admin")
    consola.info(`Created admin account '${email}' from environment.`)
    return true
  } catch (error) {
    consola.warn(
      "Could not create admin account from environment:",
      error instanceof Error ? error.message : error,
    )
    return false
  }
}
