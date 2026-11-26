import consola from "consola"
import { randomBytes } from "node:crypto"

import {
  hashGatewayApiKey,
  legacyApiKeyId,
  maskGatewayApiKey,
  normalizeApiKeyRecord,
  normalizeApiKeyRecords,
  type ApiKeyQuotaPeriod,
  type GatewayApiKeyConfig,
} from "../config/api-key-config"
import {
  readEditableConfigFromDisk,
  reloadConfig,
  writeConfigToDisk,
} from "../config/config-store"
import { getPgClient } from "../pg/client"
import type { AppConfig } from "../types/config"

export const BOOTSTRAP_API_KEY_ID = "bkg-ov-clients"
const MAX_API_KEYS = 10_000

/** Minimal, injectable surface of postgres.js used by the key store. */
export interface GatewayApiKeySql {
  unsafe(
    query: string,
    params?: Array<unknown>,
  ): Promise<Array<Record<string, unknown>>>
}

export type GatewayApiKeyStoreErrorCode =
  "conflict" | "invalid" | "not_found" | "unavailable"

export class GatewayApiKeyStoreError extends Error {
  readonly code: GatewayApiKeyStoreErrorCode

  constructor(message: string, code: GatewayApiKeyStoreErrorCode) {
    super(message)
    this.name = "GatewayApiKeyStoreError"
    this.code = code
  }
}

export interface GatewayApiKeyCreateInput {
  key: string
  name?: string
  enabled?: boolean
  expiresAt?: string | null
  allowedModels?: Array<string> | null
  quota?: { period: ApiKeyQuotaPeriod; amount: number } | null
}

export interface GatewayApiKeyUpdateInput {
  name?: string
  enabled?: boolean
  expiresAt?: string | null
  allowedModels?: Array<string> | null
  quota?: { period: ApiKeyQuotaPeriod; amount: number } | null
}

export interface GatewayApiKeyStoreOptions {
  getSql?: () => GatewayApiKeySql | null
}

interface KeySnapshot {
  byId: Map<string, GatewayApiKeyConfig>
  byHash: Map<string, GatewayApiKeyConfig>
}

const KEY_COLUMNS =
  "id, key_hash, key_hint, name, enabled, expires_at, allowed_models, quota_period, quota_amount"

const SCHEMA_STATEMENTS = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  "SET search_path TO public, extensions",
  `CREATE TABLE IF NOT EXISTS gateway_api_keys (
     id             text        PRIMARY KEY,
     key_hash       text        NOT NULL UNIQUE,
     key_hint       text        NOT NULL,
     name           text        NOT NULL DEFAULT '',
     enabled        boolean     NOT NULL DEFAULT true,
     expires_at     timestamptz,
     allowed_models jsonb       NOT NULL DEFAULT '[]'::jsonb,
     quota_period   text,
     quota_amount   numeric,
     created_at     timestamptz NOT NULL DEFAULT now(),
     updated_at     timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_enabled
     ON gateway_api_keys (enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_expires_at
     ON gateway_api_keys (expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_allowed_models
     ON gateway_api_keys USING GIN (allowed_models)`,
  `CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_created
     ON gateway_api_keys (created_at, id)`,
]

const INSERT_KEY_SQL = `
  INSERT INTO gateway_api_keys
    (id, key_hash, key_hint, name, enabled, expires_at, allowed_models,
     quota_period, quota_amount)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
  ON CONFLICT (id) DO NOTHING
  RETURNING ${KEY_COLUMNS}
`

const SELECT_KEYS_SQL = `
  SELECT ${KEY_COLUMNS}
  FROM gateway_api_keys
  ORDER BY created_at, id
  LIMIT $1
`

function defaultSql(): GatewayApiKeySql | null {
  const client = getPgClient()
  if (!client) return null
  return {
    async unsafe(query, params = []) {
      return (await client.unsafe(query, params as never[])) as Array<
        Record<string, unknown>
      >
    },
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function iso(value: unknown): string | undefined {
  const date =
    value instanceof Date ? value
    : typeof value === "string" && value.trim() ? new Date(value)
    : undefined
  if (!date || Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function parseAllowedModels(value: unknown): Array<string> | undefined {
  const parsed =
    typeof value === "string" ?
      (() => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          return []
        }
      })()
    : value
  if (!Array.isArray(parsed)) return undefined
  const models = parsed.filter((entry) => typeof entry === "string")
  // ["*"] is the database representation of "unrestricted" because the column
  // must stay a JSON array while [] means "no model is allowed".
  return models.length === 1 && models[0] === "*" ? undefined : models
}

function storedAllowedModels(models: Array<string> | undefined | null): string {
  const value =
    !models || (models.length === 1 && models[0] === "*") ? ["*"] : models
  return JSON.stringify(value)
}

function parseQuotaPeriod(value: unknown): ApiKeyQuotaPeriod | undefined {
  return value === "day" || value === "month" || value === "lifetime" ?
      value
    : undefined
}

function rowToConfig(row: Record<string, unknown>): GatewayApiKeyConfig {
  const keyHash = str(row.key_hash)
  const expiresAt = iso(row.expires_at)
  const allowedModels = parseAllowedModels(row.allowed_models)
  const quotaPeriod = parseQuotaPeriod(row.quota_period)
  const record: GatewayApiKeyConfig = {
    id: str(row.id),
    keyHash,
    keyHint: str(row.key_hint) || `${keyHash.slice(0, 4)}…${keyHash.slice(-4)}`,
    enabled: row.enabled !== false,
    ...(expiresAt && { expiresAt }),
    ...(allowedModels !== undefined && { allowedModels }),
    ...(quotaPeriod && {
      quota: { period: quotaPeriod, amount: Number(row.quota_amount) || 0 },
    }),
  }
  const normalized = normalizeApiKeyRecord(record)
  return { ...normalized, name: str(row.name) }
}

function buildSnapshot(keys: Array<GatewayApiKeyConfig>): KeySnapshot {
  const byId = new Map<string, GatewayApiKeyConfig>()
  const byHash = new Map<string, GatewayApiKeyConfig>()
  for (const key of keys) {
    byId.set(key.id, key)
    if (key.keyHash) byHash.set(key.keyHash, key)
  }
  return { byId, byHash }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "23505"
  )
}

function handleSchemaStatementError(statement: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (
    statement.startsWith("CREATE EXTENSION")
    && /permission denied|already exists/iu.test(message)
  ) {
    return
  }
  throw error
}

function quotaValues(
  quota: { period: ApiKeyQuotaPeriod; amount: number } | null | undefined,
): [string | null, number | null] {
  return quota ? [quota.period, quota.amount] : [null, null]
}

function createKeyInput(input: GatewayApiKeyCreateInput): GatewayApiKeyConfig {
  const key = input.key.trim()
  if (!key) {
    throw new GatewayApiKeyStoreError("API key must not be empty", "invalid")
  }
  const name = input.name?.trim()
  return normalizeApiKeyRecord({
    id: legacyApiKeyId(key),
    key,
    ...(name && { name }),
    enabled: input.enabled ?? true,
    ...(input.expiresAt && { expiresAt: input.expiresAt }),
    ...(input.allowedModels != null && {
      allowedModels: input.allowedModels,
    }),
    ...(input.quota && { quota: input.quota }),
    keyHint: maskGatewayApiKey(key),
  })
}

function normalizeUpdateInput(
  existing: GatewayApiKeyConfig,
  patch: GatewayApiKeyUpdateInput,
): GatewayApiKeyUpdateInput {
  if ("key" in patch || "keyHash" in patch) {
    throw new GatewayApiKeyStoreError(
      "API key and keyHash cannot be changed",
      "invalid",
    )
  }
  const probe: Record<string, unknown> = {
    id: existing.id,
    keyHash: existing.keyHash,
  }
  if (patch.name !== undefined) probe.name = patch.name
  if (patch.enabled !== undefined) probe.enabled = patch.enabled
  if (patch.expiresAt) probe.expiresAt = patch.expiresAt
  if (patch.allowedModels != null) probe.allowedModels = patch.allowedModels
  if (patch.quota) probe.quota = patch.quota
  const normalized = normalizeApiKeyRecord(probe)
  return {
    name: normalized.name ?? "",
    enabled: normalized.enabled ?? true,
    expiresAt:
      patch.expiresAt === null ? null
      : normalized.expiresAt ? normalized.expiresAt
      : undefined,
    allowedModels:
      patch.allowedModels === null ? null
      : normalized.allowedModels !== undefined ? normalized.allowedModels
      : undefined,
    quota: patch.quota === null ? null : normalized.quota,
  }
}

export function generateGatewayApiKey(): string {
  return randomBytes(32).toString("base64url")
}

/** Postgres-backed key store: one atomic in-memory snapshot, no per-request SQL. */
export class GatewayApiKeyStore {
  private schemaReady = false
  private configMigrated = false
  private snapshot: KeySnapshot | null = null
  private loading: Promise<Array<GatewayApiKeyConfig>> | null = null
  private readonly getSql: () => GatewayApiKeySql | null

  constructor(options: GatewayApiKeyStoreOptions = {}) {
    this.getSql = options.getSql ?? defaultSql
  }

  hasDatabase(): boolean {
    return this.getSql() !== null
  }

  /** O(1) lookup used by the auth middleware on every request. */
  lookupByHash(keyHash: string): GatewayApiKeyConfig | undefined {
    return this.snapshot?.byHash.get(keyHash)
  }

  peek(): Array<GatewayApiKeyConfig> {
    return this.snapshot ? [...this.snapshot.byId.values()] : []
  }

  invalidate(): void {
    this.snapshot = null
    this.configMigrated = false
  }

  async ensureSchema(): Promise<boolean> {
    const sql = this.getSql()
    if (!sql) return false
    if (this.schemaReady) return true
    for (const statement of SCHEMA_STATEMENTS) {
      try {
        await sql.unsafe(statement)
      } catch (error) {
        handleSchemaStatementError(statement, error)
      }
    }
    this.schemaReady = true
    return true
  }

  async listKeys(): Promise<Array<GatewayApiKeyConfig>> {
    if (this.snapshot) return this.peek()
    if (!this.loading) {
      this.loading = this.loadKeys().finally(() => {
        this.loading = null
      })
    }
    return await this.loading
  }

  async create(
    input: GatewayApiKeyCreateInput,
  ): Promise<{ key: string; config: GatewayApiKeyConfig }> {
    const sql = await this.requireSql()
    await this.listKeys()
    const config = createKeyInput(input)
    const rows = await this.insertRow(sql, config)
    const row = rows[0]
    if (!row) {
      throw new GatewayApiKeyStoreError(
        "API key or key id already exists",
        "conflict",
      )
    }
    const created = rowToConfig(row)
    this.commitKey(created)
    return { key: input.key.trim(), config: created }
  }

  async update(
    id: string,
    patch: GatewayApiKeyUpdateInput,
  ): Promise<GatewayApiKeyConfig> {
    const sql = await this.requireSql()
    await this.listKeys()
    const existing = this.snapshot?.byId.get(id)
    if (!existing) {
      throw new GatewayApiKeyStoreError("API key not found", "not_found")
    }
    const update = normalizeUpdateInput(existing, patch)
    const assignments: Array<string> = []
    const values: Array<unknown> = []
    const add = (column: string, value: unknown) => {
      values.push(value)
      assignments.push(`${column} = $${values.length}`)
    }
    if (update.name !== undefined) add("name", update.name)
    if (update.enabled !== undefined) add("enabled", update.enabled)
    if (update.expiresAt !== undefined) add("expires_at", update.expiresAt)
    if (update.allowedModels !== undefined)
      add("allowed_models", storedAllowedModels(update.allowedModels))
    if (update.quota !== undefined) {
      const [period, amount] = quotaValues(update.quota)
      add("quota_period", period)
      add("quota_amount", amount)
    }
    if (assignments.length === 0) return existing

    values.push(id)
    const rows = await sql.unsafe(
      `UPDATE gateway_api_keys SET ${assignments.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING ${KEY_COLUMNS}`,
      values,
    )
    const row = rows[0]
    if (!row) {
      throw new GatewayApiKeyStoreError("API key not found", "not_found")
    }
    const updated = rowToConfig(row)
    this.commitKey(updated)
    return updated
  }

  async delete(id: string): Promise<void> {
    const sql = await this.requireSql()
    await this.listKeys()
    if (!this.snapshot?.byId.has(id)) {
      throw new GatewayApiKeyStoreError("API key not found", "not_found")
    }
    const rows = await sql.unsafe(
      "DELETE FROM gateway_api_keys WHERE id = $1 RETURNING id",
      [id],
    )
    if (rows.length === 0) {
      throw new GatewayApiKeyStoreError("API key not found", "not_found")
    }
    const next = new Map(this.snapshot.byId)
    next.delete(id)
    this.commitSnapshot(buildSnapshot([...next.values()]))
  }

  private commitKey(key: GatewayApiKeyConfig): void {
    const current = this.snapshot
    const next =
      current ?
        new Map<string, GatewayApiKeyConfig>(current.byId)
      : new Map<string, GatewayApiKeyConfig>()
    next.set(key.id, key)
    this.commitSnapshot(buildSnapshot([...next.values()]))
  }

  private commitSnapshot(snapshot: KeySnapshot): void {
    // One reference swap: readers see either the old or the new complete map.
    this.snapshot = snapshot
  }

  private async requireSql(): Promise<GatewayApiKeySql> {
    const sql = this.getSql()
    if (!sql) {
      throw new GatewayApiKeyStoreError("Postgres unavailable", "unavailable")
    }
    await this.ensureSchema()
    return sql
  }

  private async insertRow(
    sql: GatewayApiKeySql,
    config: GatewayApiKeyConfig,
  ): Promise<Array<Record<string, unknown>>> {
    const [quotaPeriod, quotaAmount] = quotaValues(config.quota)
    try {
      return await sql.unsafe(INSERT_KEY_SQL, [
        config.id,
        config.keyHash ?? hashGatewayApiKey(config.key ?? ""),
        config.keyHint ?? maskGatewayApiKey(config.key ?? ""),
        config.name ?? "",
        config.enabled !== false,
        config.expiresAt ?? null,
        storedAllowedModels(config.allowedModels),
        quotaPeriod,
        quotaAmount,
      ])
    } catch (error) {
      if (isUniqueViolation(error)) return []
      throw error
    }
  }

  private async loadKeys(): Promise<Array<GatewayApiKeyConfig>> {
    const sql = this.getSql()
    if (!sql) return []
    await this.ensureSchema()
    await this.migrateConfigKeys(sql)
    const rows = await sql.unsafe(SELECT_KEYS_SQL, [MAX_API_KEYS])
    if (rows.length >= MAX_API_KEYS) {
      consola.warn(
        `Gateway API key snapshot reached its ${MAX_API_KEYS} key limit`,
      )
    }
    const snapshot = buildSnapshot(rows.map(rowToConfig))
    this.commitSnapshot(snapshot)
    return this.peek()
  }

  private async migrateConfigKeys(sql: GatewayApiKeySql): Promise<void> {
    if (this.configMigrated) return
    this.configMigrated = true
    const config: AppConfig = readEditableConfigFromDisk()
    const entries = normalizeApiKeyRecords(config.auth?.apiKeyConfigs)
    let rewroteConfig = false
    const migrated: Array<GatewayApiKeyConfig> = []

    for (const entry of entries) {
      const keyHash =
        entry.keyHash ?? (entry.key ? hashGatewayApiKey(entry.key) : undefined)
      if (!keyHash) continue
      const keyHint =
        entry.keyHint
        ?? (entry.key ?
          maskGatewayApiKey(entry.key)
        : maskGatewayApiKey(keyHash))
      const row: GatewayApiKeyConfig = {
        ...entry,
        keyHash,
        keyHint,
        ...(entry.key && { key: undefined }),
      }
      await this.insertRow(sql, row)
      migrated.push(row)
      if (entry.key) rewroteConfig = true
    }

    if (rewroteConfig) {
      writeConfigToDisk({
        ...config,
        auth: { ...config.auth, apiKeyConfigs: migrated },
      })
      reloadConfig()
    }
  }
}

export const gatewayApiKeyStore = new GatewayApiKeyStore()
