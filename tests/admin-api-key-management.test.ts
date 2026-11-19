import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  generateGatewayApiKey,
  generateGatewayApiKeyId,
  maskApiKey,
} from "../src/lib/api-key-config"

test("generates recognisable, unique gateway keys and stable ids", () => {
  const first = generateGatewayApiKey()
  const second = generateGatewayApiKey()
  expect(first.startsWith("cpa_")).toBe(true)
  expect(first).not.toBe(second)

  const masked = maskApiKey(first)
  expect(masked.startsWith("cpa_")).toBe(true)
  expect(masked.endsWith(first.slice(-4))).toBe(true)
  expect(masked.includes(first.slice(6, -4))).toBe(false)

  expect(generateGatewayApiKeyId()).toMatch(/^key_[0-9a-f]{32}$/)
})

test("admin API-key management and admin-key password reset", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-admin-keys-"))
  try {
    const config = {
      auth: {
        adminApiKey: "admin-key",
        apiKeyConfigs: [{ id: "seed", key: "seed-key", name: "Seed" }],
      },
    }
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config))
    const script = [
      'import { Hono } from "hono"',
      'import { createAuthMiddleware, getConfiguredAdminApiKeys } from "./src/lib/request-auth.ts"',
      'import { apiKeyManagementRoutes } from "./src/routes/admin/api-keys/manage-route.ts"',
      'import { authRoutes } from "./src/routes/auth/route.ts"',
      'import { getUserStore } from "./src/lib/users.ts"',
      'import { closeUsageStore } from "./src/lib/token-usage/index.ts"',
      "const app = new Hono()",
      'app.use("/admin/*", createAuthMiddleware({ getApiKeys: getConfiguredAdminApiKeys, allowWhenNoApiKeys: false, allowUnauthenticatedPaths: [] }))',
      'app.route("/admin/api-keys", apiKeyManagementRoutes)',
      'app.route("/auth", authRoutes)',
      "const call = (method, url, options = {}) => app.request(url, {",
      "  method,",
      '  headers: { ...(options.key ? { "x-api-key": options.key } : {}), ...(options.body !== undefined ? { "content-type": "application/json" } : {}) },',
      "  ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),",
      "})",
      'await getUserStore().createUser("admin@example.com", "initial-password-123", "admin")',
      "const result = {}",
      'result.noAuth = (await call("GET", "/admin/api-keys")).status',
      'const created = await call("POST", "/admin/api-keys", { key: "admin-key", body: { name: "Alice", allowedModels: ["codex/gpt-good"], quota: { period: "month", amount: 25 } } })',
      "result.createStatus = created.status",
      "const createdBody = await created.json()",
      "result.created = createdBody.key",
      'result.wrongKey = (await call("POST", "/admin/api-keys", { key: "nope", body: {} })).status',
      'result.duplicate = (await call("POST", "/admin/api-keys", { key: "admin-key", body: { key: "seed-key" } })).status',
      'result.list = await (await call("GET", "/admin/api-keys", { key: "admin-key" })).json()',
      'const patched = await call("PATCH", "/admin/api-keys/" + createdBody.key.id, { key: "admin-key", body: { name: "Alice Two", allowedModels: null, quota: null } })',
      "result.patchStatus = patched.status",
      "result.patched = (await patched.json()).key",
      'result.patchMissing = (await call("PATCH", "/admin/api-keys/missing", { key: "admin-key", body: {} })).status',
      'result.deleteStatus = (await call("DELETE", "/admin/api-keys/" + createdBody.key.id, { key: "admin-key" })).status',
      'result.deleteMissing = (await call("DELETE", "/admin/api-keys/missing", { key: "admin-key" })).status',
      'result.afterDelete = await (await call("GET", "/admin/api-keys", { key: "admin-key" })).json()',
      'result.resetOk = (await call("POST", "/auth/password/reset-via-admin", { body: { email: "admin@example.com", password: "brand-new-password-1", adminKey: "admin-key" } })).status',
      'result.verifyNew = Boolean(await getUserStore().verifyCredentials("admin@example.com", "brand-new-password-1"))',
      'result.resetHeaderKey = (await app.request("/auth/password/reset-via-admin", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "admin-key" }, body: JSON.stringify({ email: "admin@example.com", password: "header-key-password-1" }) })).status',
      'result.resetBadKey = (await call("POST", "/auth/password/reset-via-admin", { body: { email: "admin@example.com", password: "whatever-long-1", adminKey: "wrong" } })).status',
      'result.resetUnknown = (await call("POST", "/auth/password/reset-via-admin", { body: { email: "nobody@example.com", password: "whatever-long-1", adminKey: "admin-key" } })).status',
      'result.resetShort = (await call("POST", "/auth/password/reset-via-admin", { body: { email: "admin@example.com", password: "short", adminKey: "admin-key" } })).status',
      "await closeUsageStore()",
      'console.log("RESULT " + JSON.stringify(result))',
    ].join("\n")
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.join(import.meta.dir, ".."),
      env: {
        ...process.env,
        COPILOT_API_HOME: home,
        COPILOT_API_SQLITE_DB_PATH: path.join(home, "usage.sqlite"),
        COPILOT_API_OAUTH_APP: "",
        COPILOT_API_ENTERPRISE_URL: "",
      },
    })
    const stdout = new TextDecoder().decode(child.stdout)
    const stderr = new TextDecoder().decode(child.stderr)
    if (child.exitCode !== 0) throw new Error(stdout + "\n" + stderr)
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "))
    if (!line) throw new Error(stdout + "\n" + stderr)
    const result = JSON.parse(line.slice(7)) as {
      noAuth: number
      createStatus: number
      created: {
        id: string
        name: string
        key: string
        maskedKey: string
        allowedModels: Array<string>
        quota: { period: string; amount: number }
        usage: { totalTokens: number; requestCount: number }
      }
      wrongKey: number
      duplicate: number
      list: { keys: Array<{ id: string; name: string }> }
      patchStatus: number
      patched: { name: string; allowedModels: unknown; quota: unknown }
      patchMissing: number
      deleteStatus: number
      deleteMissing: number
      afterDelete: { keys: Array<{ id: string }> }
      resetOk: number
      verifyNew: boolean
      resetHeaderKey: number
      resetBadKey: number
      resetUnknown: number
      resetShort: number
    }

    expect(result.noAuth).toBe(401)
    expect(result.createStatus).toBe(201)
    expect(result.created.key.startsWith("cpa_")).toBe(true)
    expect(result.created.maskedKey).not.toBe(result.created.key)
    expect(result.created.name).toBe("Alice")
    expect(result.created.allowedModels).toEqual(["codex/gpt-good"])
    expect(result.created.quota).toEqual({ period: "month", amount: 25 })
    expect(result.created.usage.totalTokens).toBe(0)
    expect(result.created.usage.requestCount).toBe(0)
    expect(result.wrongKey).toBe(401)
    expect(result.duplicate).toBe(400)
    expect(result.list.keys.map((key) => key.id).sort()).toEqual(
      ["seed", result.created.id].sort(),
    )
    expect(result.patchStatus).toBe(200)
    expect(result.patched.name).toBe("Alice Two")
    expect(result.patched.allowedModels).toBeNull()
    expect(result.patched.quota).toBeNull()
    expect(result.patchMissing).toBe(404)
    expect(result.deleteStatus).toBe(200)
    expect(result.deleteMissing).toBe(404)
    expect(result.afterDelete.keys.map((key) => key.id)).toEqual(["seed"])

    expect(result.resetOk).toBe(200)
    expect(result.verifyNew).toBe(true)
    expect(result.resetHeaderKey).toBe(200)
    expect(result.resetBadKey).toBe(401)
    expect(result.resetUnknown).toBe(404)
    expect(result.resetShort).toBe(400)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
