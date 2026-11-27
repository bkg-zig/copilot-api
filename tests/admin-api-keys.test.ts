import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { GatewayApiKeyStore } from "~/lib/auth/gateway-api-keys"
import {
  hashGatewayApiKey,
  type GatewayApiKeyConfig,
} from "~/lib/config/api-key-config"
import { setConfigPathOverride } from "~/lib/config/config-store"
import { createApiKeyAdminRoutes } from "~/routes/admin/api-keys/route"

import { createApiKeySqlMock, type ApiKeyMockDb } from "./api-keys-pg-mock"

let home: string
let db: ApiKeyMockDb
let store: GatewayApiKeyStore
let app: Hono
let usageIds: Array<string>

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-admin-keys-"))
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ auth: { apiKeyConfigs: [] } }),
  )
  setConfigPathOverride(path.join(home, "config.json"))
  const mock = createApiKeySqlMock()
  db = mock.db
  store = new GatewayApiKeyStore({ getSql: () => mock.sql })
  usageIds = []
  const routes = createApiKeyAdminRoutes({
    store,
    getUsage: (key: GatewayApiKeyConfig) => {
      usageIds.push(key.id)
      return Promise.resolve({
        usedAmount: 1,
        remainingAmount: 9,
        resetsAt: 42_000,
      })
    },
  })
  app = new Hono()
  app.route("/admin/api-keys", routes)
})

afterEach(() => {
  setConfigPathOverride(null)
  fs.rmSync(home, { recursive: true, force: true })
})

async function call(
  url: string,
  options: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request(url, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  }
}

test("GET lists safe key views with quota usage", async () => {
  const created = await store.create({
    key: "admin-view-secret",
    name: "Client",
    allowedModels: ["bkg-api/*"],
    quota: { period: "day", amount: 10 },
  })

  const result = await call("/admin/api-keys")
  expect(result.status).toBe(200)
  const keys = result.body.keys as Array<Record<string, unknown>>
  expect(keys).toHaveLength(1)
  expect(keys[0]).toMatchObject({
    id: created.config.id,
    name: "Client",
    keyHint: "admi…cret",
    allowedModels: ["bkg-api/*"],
    quota: { period: "day", amount: 10 },
    usage: { usedAmount: 1, remainingAmount: 9, resetsAt: 42_000 },
  })
  expect(JSON.stringify(result.body)).not.toContain("admin-view-secret")
  expect(JSON.stringify(result.body)).not.toContain(
    hashGatewayApiKey("admin-view-secret"),
  )
  expect(usageIds).toEqual([created.config.id])
})

test("POST returns the secret once and persists only its hash", async () => {
  const result = await call("/admin/api-keys", {
    method: "POST",
    body: JSON.stringify({
      key: "create-once-secret",
      name: "Created",
      allowedModels: ["bkg-api/*"],
    }),
  })

  expect(result.status).toBe(201)
  expect(result.body.key).toBe("create-once-secret")
  const view = result.body.view as Record<string, unknown>
  expect(view.id).toBe(
    "key_" + hashGatewayApiKey("create-once-secret").slice(0, 32),
  )
  expect(view.name).toBe("Created")
  expect(view.keyHint).toBe("crea…cret")
  expect(JSON.stringify(view)).not.toContain("create-once-secret")
  expect([...db.rows.values()][0]?.key_hash).toBe(
    hashGatewayApiKey("create-once-secret"),
  )
  expect(JSON.stringify([...db.rows.values()])).not.toContain(
    "create-once-secret",
  )
})

test("POST without a key generates one", async () => {
  const result = await call("/admin/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: "Generated" }),
  })
  expect(result.status).toBe(201)
  expect(typeof result.body.key).toBe("string")
  expect((result.body.key as string).length).toBeGreaterThan(20)
  expect([...db.rows.values()]).toHaveLength(1)
})

test("PATCH validates, clears restrictions and rejects key changes", async () => {
  const created = await store.create({
    key: "patch-secret-1234",
    allowedModels: ["bkg-api/*"],
  })
  const updated = await call(`/admin/api-keys/${created.config.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Renamed", allowedModels: null }),
  })
  expect(updated.status).toBe(200)
  const view = updated.body.view as Record<string, unknown>
  expect(view.name).toBe("Renamed")
  expect(view.allowedModels).toBeNull()
  expect([...db.rows.values()][0]?.allowed_models).toBe('["*"]')

  const forbidden = await call(`/admin/api-keys/${created.config.id}`, {
    method: "PATCH",
    body: JSON.stringify({ key: "rotated" }),
  })
  expect(forbidden.status).toBe(400)
  expect(forbidden.body).toMatchObject({
    error: { type: "invalid_request_error" },
  })
  expect(typeof (forbidden.body.error as Record<string, unknown>).message).toBe(
    "string",
  )

  const missing = await call("/admin/api-keys/does-not-exist", {
    method: "PATCH",
    body: JSON.stringify({ name: "x" }),
  })
  expect(missing.status).toBe(404)
  expect(missing.body).toMatchObject({ error: { type: "not_found_error" } })

  const invalid = await call("/admin/api-keys/bad%20id", {
    method: "PATCH",
    body: JSON.stringify({ name: "x" }),
  })
  expect(invalid.status).toBe(400)
})

test("DELETE returns 204 and reports missing keys", async () => {
  const created = await store.create({ key: "delete-secret-1234" })
  const deleted = await call(`/admin/api-keys/${created.config.id}`, {
    method: "DELETE",
  })
  expect(deleted.status).toBe(204)
  expect(deleted.body).toEqual({})

  const missing = await call(`/admin/api-keys/${created.config.id}`, {
    method: "DELETE",
  })
  expect(missing.status).toBe(404)
  expect(missing.body.error).toMatchObject({ type: "not_found_error" })
})
