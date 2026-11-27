/* eslint-disable @typescript-eslint/require-await -- async postgres.js test double */
import type { GatewayApiKeySql } from "~/lib/auth/gateway-api-keys"

type Row = Record<string, unknown>

export interface ApiKeyMockDb {
  rows: Map<string, Row>
  selects: number
  writes: number
  seed: (rows: Array<Row>) => void
  reset: () => void
}

export interface ApiKeyMockResult {
  sql: GatewayApiKeySql
  db: ApiKeyMockDb
}

function uniqueViolation(): Error & { code: string } {
  return Object.assign(
    new Error("duplicate key value violates unique constraint"),
    {
      code: "23505",
    },
  )
}

function normalizedQuery(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

/** In-memory stand-in for the exact queries used by GatewayApiKeyStore. */
export function createApiKeySqlMock(): ApiKeyMockResult {
  const rows = new Map<string, Row>()
  const db: ApiKeyMockDb = {
    rows,
    selects: 0,
    writes: 0,
    seed(next) {
      rows.clear()
      for (const row of next) rows.set(String(row.id), row)
    },
    reset() {
      rows.clear()
      db.selects = 0
      db.writes = 0
    },
  }

  const sql: GatewayApiKeySql = {
    async unsafe(text, params = []) {
      const query = normalizedQuery(text)
      if (
        query.startsWith("CREATE ")
        || query.startsWith("SET ")
        || query.startsWith("DROP ")
      ) {
        return []
      }
      if (query.startsWith("INSERT INTO gateway_api_keys")) {
        db.writes += 1
        const id = String(params[0])
        const keyHash = String(params[1])
        if (
          rows.has(id)
          || [...rows.values()].some((row) => row.key_hash === keyHash)
        ) {
          throw uniqueViolation()
        }
        const row: Row = {
          id,
          key_hash: keyHash,
          key_hint: params[2],
          name: params[3],
          enabled: params[4],
          expires_at: params[5],
          allowed_models: params[6],
          quota_period: params[7],
          quota_amount: params[8],
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          updated_at: new Date("2026-01-01T00:00:00.000Z"),
        }
        rows.set(id, row)
        return [row]
      }
      if (
        query.startsWith("SELECT")
        && query.includes("FROM gateway_api_keys")
      ) {
        db.selects += 1
        const limit = Number(params[0]) || rows.size
        return [...rows.values()].slice(0, limit)
      }
      if (query.startsWith("UPDATE gateway_api_keys")) {
        db.writes += 1
        const set = /SET (.*?) WHERE id = \$(\d+)/u.exec(query)
        if (!set) throw new Error(`unsupported mock update: ${query}`)
        const id = String(params[Number(set[2]) - 1])
        const row = rows.get(id)
        if (!row) return []
        for (const match of set[1].matchAll(/(\w+) = \$(\d+)/gu)) {
          row[match[1]] = params[Number(match[2]) - 1]
        }
        row.updated_at = new Date("2026-01-02T00:00:00.000Z")
        return [row]
      }
      if (query.startsWith("DELETE FROM gateway_api_keys")) {
        db.writes += 1
        const id = String(params[0])
        if (!rows.delete(id)) return []
        return [{ id }]
      }
      throw new Error(`unsupported mock query: ${query}`)
    },
  }
  return { sql, db }
}
