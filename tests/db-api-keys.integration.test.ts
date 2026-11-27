import { afterAll, expect, test } from "bun:test"
import postgres from "postgres"

import {
  GatewayApiKeyStore,
  type GatewayApiKeySql,
} from "~/lib/auth/gateway-api-keys"
import { hashGatewayApiKey, legacyApiKeyId } from "~/lib/config/api-key-config"

const url = process.env.SUPABASE_DB_URL?.trim()
const describe = url ? test : test.skip

describe("GatewayApiKeyStore against real Postgres", async () => {
  const secret = "pg-itest-secret-abcdefgh"
  const id = legacyApiKeyId(secret)
  const client = postgres(url!, { prepare: false })
  const sql: GatewayApiKeySql = {
    async unsafe(query, params = []) {
      return (await client.unsafe(query, params as never[])) as Array<
        Record<string, unknown>
      >
    },
  }
  const store = new GatewayApiKeyStore({ getSql: () => sql })

  afterAll(async () => {
    await store.ensureSchema()
    await client.unsafe("DELETE FROM gateway_api_keys WHERE id = $1", [id])
    await client.end()
  })

  await store.ensureSchema()
  await client.unsafe("DELETE FROM gateway_api_keys WHERE id = $1", [id])

  const columns = await sql.unsafe(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'gateway_api_keys' ORDER BY ordinal_position",
  )
  expect(columns.map((row) => row.column_name)).toEqual([
    "id",
    "key_hash",
    "key_hint",
    "name",
    "enabled",
    "expires_at",
    "allowed_models",
    "quota_period",
    "quota_amount",
    "created_at",
    "updated_at",
  ])

  const created = await store.create({
    key: secret,
    name: "Integration",
    allowedModels: ["bkg-api/*"],
    quota: { period: "day", amount: 3 },
  })
  expect(created.config.id).toBe(id)
  expect(created.config.key).toBeUndefined()
  expect(store.lookupByHash(hashGatewayApiKey(secret))?.id).toBe(id)

  const rows = await sql.unsafe(
    "SELECT id, key_hash, key_hint, name, enabled, allowed_models, quota_period, quota_amount FROM gateway_api_keys WHERE id = $1",
    [id],
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]?.key_hash).toBe(hashGatewayApiKey(secret))
  expect(rows[0]?.key_hint).toBe("pg-i…efgh")
  expect(JSON.stringify(rows)).not.toContain(secret)

  const updated = await store.update(id, {
    enabled: false,
    allowedModels: null,
  })
  expect(updated.enabled).toBe(false)
  expect(updated.allowedModels).toBeUndefined()
  const storedModels = await sql.unsafe(
    "SELECT allowed_models FROM gateway_api_keys WHERE id = $1",
    [id],
  )
  expect(JSON.parse(String(storedModels[0]?.allowed_models))).toEqual(["*"])

  expect(await store.listKeys()).toHaveLength(1)
  await store.delete(id)
  expect(await store.listKeys()).toHaveLength(0)
})
