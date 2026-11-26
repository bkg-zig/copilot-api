import { expect, spyOn, test } from "bun:test"
import consola from "consola"
import { Hono } from "hono"

import {
  createAuthMiddleware,
  getConfiguredApiKeyCount,
  getEffectiveGatewayApiKeys,
  getMissingApiKeysMessage,
  initializeGatewayApiKeys,
} from "~/lib/auth/request-auth"
import {
  hashGatewayApiKey,
  type GatewayApiKeyConfig,
} from "~/lib/config/api-key-config"
import * as config from "~/lib/config"
import { requestContext } from "~/lib/http/request-context"
import { traceIdMiddleware } from "~/lib/http/trace"

const secret = "db-auth-secret-abcd"
const dbKey: GatewayApiKeyConfig = {
  id: "db-key",
  keyHash: hashGatewayApiKey(secret),
  keyHint: "db-a…abcd",
  enabled: true,
  allowedModels: ["bkg-api/*"],
}

function createApp(readKeys: () => Promise<Array<GatewayApiKeyConfig>>): Hono {
  const app = new Hono()
  app.use("*", traceIdMiddleware)
  app.use(
    "*",
    createAuthMiddleware({
      getGatewayApiKeys: readKeys,
      allowUnauthenticatedPaths: [],
    }),
  )
  app.get("/models", (c) =>
    c.json({ apiKeyId: requestContext.getStore()?.apiKey?.id ?? null }),
  )
  return app
}

test("authenticates via the hashed snapshot and exposes the key in context", async () => {
  const app = createApp(() => Promise.resolve([dbKey]))
  const response = await app.request("/models", {
    headers: { "x-api-key": secret },
  })

  expect(response.status).toBe(200)
  expect(response.headers.get("X-API-Key-Usage-Isolated")).toBe("false")
  expect(await response.json()).toEqual({ apiKeyId: "db-key" })

  const rejected = await app.request("/models", {
    headers: { "x-api-key": "wrong-secret" },
  })
  expect(rejected.status).toBe(401)
})

test("rejects disabled snapshot keys and allows an empty snapshot", async () => {
  const disabled = await createApp(() =>
    Promise.resolve([{ ...dbKey, enabled: false }]),
  ).request("/models", { headers: { "x-api-key": secret } })
  expect(disabled.status).toBe(401)

  const empty = await createApp(() => Promise.resolve([])).request("/models")
  expect(empty.status).toBe(200)
})

test("reports storage errors as 503 without logging the request key", async () => {
  const log = spyOn(consola, "error").mockImplementation(
    Object.assign(() => {}, { raw: () => {} }) as typeof consola.error,
  )
  try {
    const app = createApp(() => Promise.reject(new Error("storage down")))
    const response = await app.request("/models", {
      headers: { "x-api-key": secret },
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: {
        message: "API key storage is unavailable",
        type: "service_unavailable_error",
      },
    })
    expect(log).toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  } finally {
    log.mockRestore()
  }
})

test("keeps the config fallback helpers usable without Postgres", async () => {
  const setting = spyOn(config, "getConfig").mockReturnValue({
    auth: { apiKeyConfigs: [{ id: "legacy", key: "legacy-secret" }] },
  })
  try {
    expect(await initializeGatewayApiKeys()).toBeUndefined()
    expect(await getEffectiveGatewayApiKeys()).toEqual([
      { id: "legacy", key: "legacy-secret" },
    ])
    expect(getConfiguredApiKeyCount()).toBe(1)
    expect(getMissingApiKeysMessage()).toBeNull()
  } finally {
    setting.mockRestore()
  }
})
