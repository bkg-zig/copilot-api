import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import {
  invalidateConfigCache,
  readEditableConfigFromDisk,
  setConfigPathOverride,
  writeConfigToDisk,
} from "~/lib/config/config-store"
import { getRouterConfig, resolveRoutedModel } from "~/lib/router-runtime"
import {
  getRouterAliasModel,
  getVirtualModels,
} from "~/routes/models/model-discovery"

let configDir: string
let configPath: string

beforeEach(() => {
  configDir = mkdtempSync(path.join("/tmp/opencode", "router-integration-"))
  configPath = path.join(configDir, "config.json")
  writeFileSync(configPath, JSON.stringify({ providers: {} }))
  setConfigPathOverride(configPath)
  invalidateConfigCache()
})

afterEach(() => {
  setConfigPathOverride(null)
  invalidateConfigCache()
  rmSync(configDir, { force: true, recursive: true })
})

test("an unconfigured gateway has no router and no synthetic model", () => {
  const body = { messages: [{ content: "fix the python function" }] }
  expect(getRouterConfig()).toMatchObject({ enabled: false, alias: "auto" })
  expect(resolveRoutedModel("auto", body)).toBe("auto")
  expect(getRouterAliasModel()).toBeNull()
  expect(getVirtualModels()).toEqual([])
})

test("runtime reads the stored config and publishes the alias in the catalog", () => {
  writeConfigToDisk({
    providers: {},
    router: {
      enabled: true,
      alias: "smart",
      pool: ["plain-model", "code-qwen"],
    },
  })
  invalidateConfigCache()

  expect(
    resolveRoutedModel("smart", {
      messages: [{ content: "fix the python function" }],
    }),
  ).toBe("code-qwen")
  expect(getRouterAliasModel()).toMatchObject({
    id: "smart",
    owned_by: "router",
    display_name: "Router (smart) - 2 models",
  })
  expect(getVirtualModels().map((model) => model.id)).toEqual(["smart"])
})

test("admin router endpoint validates, persists and reloads the config", async () => {
  const { configRoutes } = await import("~/routes/admin/config/route")
  const app = new Hono()
  app.route("/admin/config", configRoutes)

  const empty = await app.request("/admin/config/router")
  expect(empty.status).toBe(200)
  expect(((await empty.json()) as { router: unknown }).router).toEqual({})

  const invalid = await app.request("/admin/config/router", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ strategy: "magic" }),
  })
  expect(invalid.status).toBe(400)
  expect(readEditableConfigFromDisk().router).toBeUndefined()

  const valid = await app.request("/admin/config/router", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      alias: " auto ",
      pool: ["code-qwen"],
      rules: [{ match: "sql", model: "db/expert", flags: "gi" }],
    }),
  })
  expect(valid.status).toBe(200)
  expect(((await valid.json()) as { router: unknown }).router).toEqual({
    enabled: true,
    alias: "auto",
    pool: ["code-qwen"],
    rules: [{ match: "sql", model: "db/expert", flags: "i" }],
  })

  invalidateConfigCache()
  expect(getRouterConfig()).toMatchObject({ enabled: true, alias: "auto" })
  expect(readEditableConfigFromDisk().router).toMatchObject({ enabled: true })
})
