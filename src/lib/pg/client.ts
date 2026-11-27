import { readFileSync } from "node:fs"

import postgres from "postgres"

import type { Sql } from "postgres"

function readDatabaseUrl(): string {
  const direct = process.env.SUPABASE_DB_URL?.trim()
  if (direct) return direct
  const file = process.env.SUPABASE_DB_URL_FILE?.trim()
  if (!file) return ""
  try {
    return readFileSync(file, "utf8").trim()
  } catch {
    return ""
  }
}

/**
 * Lazy Postgres client for the state-owner feature (SUPABASE_DB_URL).
 *
 * The gateway core must never depend on Postgres: this module is only
 * imported by state code, connects lazily, and callers handle absence
 * (null client) as "state unavailable" instead of failing requests.
 */
let cached: Sql | null | undefined

export function getPgClient(): Sql | null {
  if (cached !== undefined) {
    return cached
  }
  const url = readDatabaseUrl()
  if (!url) {
    cached = null
    return null
  }
  try {
    cached = postgres(url, {
      prepare: false,
      // IF NOT EXISTS schema setup emits NOTICEs. They are not failures.
      onnotice: () => {},
      // pgrust's mango image installs pgvector in schema extensions.
      // A plain image installs it in public. Both stay visible.
      connection: {
        search_path: "public, extensions",
      },
    })
  } catch {
    cached = null
  }
  return cached
}

export async function closePgClient(): Promise<void> {
  const client = cached
  cached = undefined
  if (client) {
    try {
      await client.end({ timeout: 2 })
    } catch {
      // Best-effort shutdown; nothing to do.
    }
  }
}

export function pgAvailable(): boolean {
  return getPgClient() !== null
}
