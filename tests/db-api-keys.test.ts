import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  BOOTSTRAP_API_KEY_ID,
  GatewayApiKeyStore,
} from "~/lib/auth/gateway-api-keys"
import { hashGatewayApiKey } from "~/lib/config/api-key-config"
import { setConfigPathOverride } from "~/lib/config/config-store"

import { createApiKeySqlMock, type ApiKeyMockDb } from "./api-keys-pg-mock"

let home: string
let configPath: string
let db: ApiKeyMockDb
let store: GatewayApiKeyStore

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-keys-"))
  configPath = path.join(home, "config.json")
  fs.writeFileSync(configPath, JSON.stringify({ auth: { apiKeyConfigs: [] } }))
  setConfigPathOverride(configPath)
  const mock = createApiKeySqlMock()
  db = mock.db
  store = new GatewayApiKeyStore({ getSql: () => mock.sql })
})

afterEach(() => {
  setConfigPathOverride(null)
  fs.rmSync(home, { recursive: true, force: true })
})

describe("Postgres gateway API key store", () => {
  test("stores only the hash and hint and never persists the secret", async () => {
    const secret = "db-test-key-0123456789"
    const created = await store.create({
      key: secret,
      name: "Client",
      allowedModels: ["bkg-api/*"],
      quota: { period: "day", amount: 5 },
    })

    expect(created.key).toBe(secret)
    expect(created.config.key).toBeUndefined()
    expect(created.config.keyHash).toBe(hashGatewayApiKey(secret))
    expect(created.config.keyHint).toBe("db-t…6789")
    const rows = [...db.rows.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key_hash).toBe(hashGatewayApiKey(secret))
    expect(rows[0]?.key_hint).toBe("db-t…6789")
    expect(JSON.stringify(rows)).not.toContain(secret)
    expect(fs.readFileSync(configPath, "utf8")).not.toContain(secret)
  })

  test("updates, deletes, validates and reports missing keys", async () => {
    const secret = "crud-key-abcdefgh"
    const created = await store.create({
      key: secret,
      allowedModels: ["bkg-api/*"],
    })
    const id = created.config.id

    const updated = await store.update(id, {
      name: "Renamed",
      enabled: false,
      expiresAt: "2030-01-01",
      allowedModels: null,
      quota: { period: "month", amount: 2 },
    })
    expect(updated.name).toBe("Renamed")
    expect(updated.enabled).toBe(false)
    expect(updated.expiresAt).toBe("2030-01-01T00:00:00.000Z")
    expect(updated.allowedModels).toBeUndefined()
    expect(updated.quota).toEqual({ period: "month", amount: 2 })
    expect([...db.rows.values()][0]?.allowed_models).toBe('["*"]')

    await Promise.resolve(
      expect(store.update(id, { key: "other" } as never)).rejects.toThrow(
        /cannot be changed/,
      ),
    )
    await Promise.resolve(
      expect(store.create({ key: secret })).rejects.toMatchObject({
        code: "conflict",
      }),
    )

    await store.delete(id)
    expect(store.peek()).toEqual([])
    await Promise.resolve(
      expect(store.update(id, { name: "x" })).rejects.toMatchObject({
        code: "not_found",
      }),
    )
    await Promise.resolve(
      expect(store.delete(id)).rejects.toMatchObject({ code: "not_found" }),
    )
  })

  test("backfills legacy config once and leaves existing dashboard rows untouched", async () => {
    const legacySecret = "legacy-backfill-secret"
    const seedSecret = "bootstrap-secret-1234"
    const seedHash = hashGatewayApiKey(seedSecret)
    const bootstrapRow = {
      id: BOOTSTRAP_API_KEY_ID,
      key_hash: seedHash,
      key_hint: "boot…1234",
      name: "Dashboard edited",
      enabled: false,
      expires_at: null,
      allowed_models: '["other/*"]',
      quota_period: null,
      quota_amount: null,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    }
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        auth: {
          apiKeyConfigs: [
            {
              id: "legacy-backfill",
              key: legacySecret,
              name: "Legacy",
              enabled: true,
              allowedModels: ["bkg-api/*"],
            },
            {
              id: BOOTSTRAP_API_KEY_ID,
              name: "Bootstrap",
              keyHash: seedHash,
              keyHint: "boot…1234",
              enabled: true,
              allowedModels: ["bkg-api/*"],
            },
          ],
        },
      }),
    )
    db.seed([bootstrapRow])

    const keys = await store.listKeys()
    const legacy = keys.find((key) => key.id === "legacy-backfill")
    const bootstrap = keys.find((key) => key.id === BOOTSTRAP_API_KEY_ID)

    expect(keys).toHaveLength(2)
    expect(legacy?.key).toBeUndefined()
    expect(legacy?.keyHash).toBe(hashGatewayApiKey(legacySecret))
    expect(bootstrap?.name).toBe("Dashboard edited")
    expect(bootstrap?.enabled).toBe(false)
    expect(bootstrap?.allowedModels).toEqual(["other/*"])
    const configText = fs.readFileSync(configPath, "utf8")
    expect(configText).not.toContain(legacySecret)
    expect(configText).not.toContain(seedSecret)
    expect([...db.rows.values()].map((row) => row.key_hash)).toContain(
      hashGatewayApiKey(legacySecret),
    )
    expect([...db.rows.values()].map((row) => row.key_hash)).toContain(seedHash)
  })

  test("serves repeated auth lookups from one atomic snapshot", async () => {
    const secret = "snapshot-key-abcdefgh"
    const created = await store.create({ key: secret })
    await store.listKeys()
    const selectsAfterLoad = db.selects

    for (let index = 0; index < 100; index += 1) {
      await store.listKeys()
      expect(store.lookupByHash(hashGatewayApiKey(secret))?.id).toBe(
        created.config.id,
      )
    }
    expect(db.selects).toBe(selectsAfterLoad)
    expect(store.peek()).toHaveLength(1)
    expect(await store.ensureSchema()).toBe(true)
  })
})
