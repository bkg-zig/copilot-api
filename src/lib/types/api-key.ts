export type ApiKeyQuotaPeriod = "day" | "month" | "lifetime"

export interface GatewayApiKeyConfig {
  id: string
  /** Only present for legacy config entries; never stored in the database. */
  key?: string
  /** Deterministic SHA-256 hash; the authoritative identity in SQLite. */
  keyHash?: string
  /** Masked hint for dashboard display, never the secret itself. */
  keyHint?: string
  name?: string
  enabled?: boolean
  expiresAt?: string
  /** undefined means unrestricted; [] denies every model. */
  allowedModels?: Array<string>
  quota?: {
    period: ApiKeyQuotaPeriod
    amount: number
  }
}

export interface ApiKeyQuotaBucket {
  api_key_id: string
  period: ApiKeyQuotaPeriod
  period_start_ms: number
  used_cost_nanos: number
}

export interface ApiKeyQuotaUsage {
  id: string
  usedAmount: number
  remainingAmount: number | null
  resetsAt: number | null
}
