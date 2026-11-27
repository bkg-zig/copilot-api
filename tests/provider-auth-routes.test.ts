import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createWebAuthService,
  initializeWebAuthDatabase,
  WEB_SESSION_COOKIE,
} from "~/lib/auth/web-session"
import {
  getRawProviderConfig,
  invalidateConfigCache,
  setProviderConfig,
} from "~/lib/config"
import { createProviderAuthRoutes } from "~/routes/auth/providers"
import { PATHS } from "~/lib/storage/paths"
import { openSqliteDatabase, type SqliteDatabase } from "~/lib/storage/sqlite"

async function sessionCookie(): Promise<{
  cookie: string
  db: SqliteDatabase
  service: ReturnType<typeof createWebAuthService>
}> {
  const email = process.env.COPI_AUTH_EMAIL?.trim() || "bkg@eysho.info"
  const password = "test-password-12"
  const db = await openSqliteDatabase(":memory:")
  initializeWebAuthDatabase(db)
  const service = createWebAuthService({
    getDb: () => Promise.resolve(db),
    allowedEmail: email,
  })
  await service.register(email, password)
  await service.login(email, password)
  const session = await service.createSession("unit-test")
  return {
    cookie: `${WEB_SESSION_COOKIE}=${session.token}`,
    db,
    service,
  }
}

test("provider auth routes require a web session and expose Claude OAuth", async () => {
  const originalConfig = PATHS.CONFIG_PATH
  const originalClaude = PATHS.CLAUDE_CREDENTIAL_PATH
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-routes-"))
  const configPath = path.join(dir, "config.json")
  fs.writeFileSync(configPath, "{}\n")
  PATHS.CONFIG_PATH = configPath
  PATHS.CLAUDE_CREDENTIAL_PATH = path.join(dir, "claude_oauth.json")
  invalidateConfigCache()
  const realNow = Date.now
  const operationIds: Array<string> = []
  let headers: Record<string, string> = {}
  // The route factory takes the session lookup, so this test runs against its
  // own in-memory database instead of the process-wide auth singleton.
  const { cookie, db, service } = await sessionCookie()
  const providerAuthRoutes = createProviderAuthRoutes(async (c) => {
    const token = c.req
      .header("cookie")
      ?.match(new RegExp(`${WEB_SESSION_COOKIE}=([^;]+)`))?.[1]
    if (!token) return null
    return await service.getSession(token)
  })
  try {
    const unauthenticated = await providerAuthRoutes.request("/status")
    expect(unauthenticated.status).toBe(401)

    headers = { cookie, "content-type": "application/json" }

    const status = await providerAuthRoutes.request("/status", { headers })
    expect(status.status).toBe(200)
    const statusBody = (await status.json()) as {
      providers: {
        anthropic: {
          connected: boolean
          authMethod: string | null
          requiresApiKey: boolean
        }
        "opencode-go": { connected: boolean }
      }
    }
    expect(statusBody.providers.anthropic.connected).toBe(false)
    expect(statusBody.providers.anthropic.authMethod).toBeNull()
    expect(statusBody.providers.anthropic.requiresApiKey).toBe(true)
    expect(statusBody.providers["opencode-go"].connected).toBe(false)

    const rejected = await providerAuthRoutes.request("/nope/start", {
      method: "POST",
      headers,
    })
    expect(rejected.status).toBe(400)

    const started = await providerAuthRoutes.request("/anthropic/start", {
      method: "POST",
      headers,
    })
    expect(started.status).toBe(202)
    const operation = (await started.json()) as {
      id: string
      auth: { url: string } | null
    }
    operationIds.push(operation.id)
    expect(operation.auth?.url).toContain("claude.ai/oauth/authorize")

    const again = await providerAuthRoutes.request("/anthropic/start", {
      method: "POST",
      headers,
    })
    expect(again.status).toBe(200)
    const againBody = (await again.json()) as { id: string }
    expect(againBody.id).toBe(operation.id)

    const connectedKey = await providerAuthRoutes.request("/anthropic", {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: "sk-ant-api03-example" }),
    })
    expect(connectedKey.status).toBe(200)
    const keyed = await providerAuthRoutes.request("/status", { headers })
    const keyedBody = (await keyed.json()) as {
      providers: {
        anthropic: { connected: boolean; authMethod: string | null }
      }
    }
    expect(keyedBody.providers.anthropic.connected).toBe(true)
    expect(keyedBody.providers.anthropic.authMethod).toBe("api-key")

    const notAnObject = await providerAuthRoutes.request("/anthropic", {
      method: "POST",
      headers,
      body: "[]",
    })
    expect(notAnObject.status).toBe(400)

    const go = await providerAuthRoutes.request("/opencode-go", {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: "oc-test-key" }),
    })
    expect(go.status).toBe(200)
    const goStatus = await providerAuthRoutes.request("/status", { headers })
    const goBody = (await goStatus.json()) as {
      providers: { "opencode-go": { connected: boolean } }
    }
    expect(goBody.providers["opencode-go"].connected).toBe(true)

    const shortGo = await providerAuthRoutes.request("/opencode-go", {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: "short" }),
    })
    expect(shortGo.status).toBe(400)
    const badGo = await providerAuthRoutes.request("/opencode-go", {
      method: "POST",
      headers,
      body: "null",
    })
    expect(badGo.status).toBe(400)
    const longGo = await providerAuthRoutes.request("/opencode-go", {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: `oc-${"k".repeat(4096)}` }),
    })
    expect(longGo.status).toBe(400)

    const missing = await providerAuthRoutes.request("/operations/missing", {
      headers,
    })
    expect(missing.status).toBe(404)
    const visible = await providerAuthRoutes.request(
      `/operations/${operation.id}`,
      { headers },
    )
    expect(visible.status).toBe(200)

    const badCallback = await providerAuthRoutes.request(
      `/operations/${operation.id}/callback`,
      { method: "POST", headers, body: JSON.stringify({ input: "  " }) },
    )
    expect(badCallback.status).toBe(400)

    const cancelled = await providerAuthRoutes.request(
      `/operations/${operation.id}/cancel`,
      { method: "POST", headers },
    )
    expect(cancelled.status).toBe(200)
    const closedCallback = await providerAuthRoutes.request(
      `/operations/${operation.id}/callback`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ input: "do-not-submit" }),
      },
    )
    expect(closedCallback.status).toBe(409)
    const missingCancel = await providerAuthRoutes.request(
      "/operations/missing/cancel",
      { method: "POST", headers },
    )
    expect(missingCancel.status).toBe(404)

    const shifted = realNow() + 11 * 60 * 1000
    Date.now = () => shifted
    const restarted = await providerAuthRoutes.request("/anthropic/start", {
      method: "POST",
      headers,
    })
    expect(restarted.status).toBe(202)
    const restartedBody = (await restarted.json()) as { id: string }
    operationIds.push(restartedBody.id)
    expect(restartedBody.id).not.toBe(operation.id)
    Date.now = realNow
    const restartedCancel = await providerAuthRoutes.request(
      `/operations/${restartedBody.id}/cancel`,
      { method: "POST", headers },
    )
    expect(restartedCancel.status).toBe(200)

    const badKey = await providerAuthRoutes.request("/anthropic", {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: "sk-ant-oat01-example" }),
    })
    expect(badKey.status).toBe(400)

    setProviderConfig("anthropic", {
      type: "anthropic",
      authType: "oauth2",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      enabled: true,
    })
    const loggedOut = await providerAuthRoutes.request("/anthropic/logout", {
      method: "POST",
      headers,
    })
    expect(loggedOut.status).toBe(200)
    expect(getRawProviderConfig("anthropic")?.enabled).toBe(false)
    expect(getRawProviderConfig("anthropic")?.apiKey).toBe("")
  } finally {
    Date.now = realNow
    for (const id of operationIds) {
      await providerAuthRoutes.request(`/operations/${id}/cancel`, {
        method: "POST",
        headers,
      })
    }
    PATHS.CONFIG_PATH = originalConfig
    PATHS.CLAUDE_CREDENTIAL_PATH = originalClaude
    invalidateConfigCache()
    db.close?.()
  }
})
