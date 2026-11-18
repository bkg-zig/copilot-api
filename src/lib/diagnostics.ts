import fs from "node:fs"
import os from "node:os"

import { sanitizeForDiagnostics } from "./redact"

const startedAt = Date.now()

let cachedVersion: string | undefined

function getPackageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown }
    cachedVersion =
      typeof packageJson.version === "string" ? packageJson.version : "unknown"
  } catch {
    cachedVersion = "unknown"
  }
  return cachedVersion
}

export interface HealthPayload {
  status: "ok"
  version: string
  uptimeSeconds: number
  timestamp: string
}

/** Minimal liveness payload: no provider, session, or credential fields. */
export function buildHealthPayload(now = Date.now()): HealthPayload {
  return {
    status: "ok",
    version: getPackageVersion(),
    uptimeSeconds: Math.max(0, Math.round((now - startedAt) / 1000)),
    timestamp: new Date(now).toISOString(),
  }
}

export interface DiagnosticsOptions {
  startedAt?: number
  extra?: Record<string, unknown>
}

/** Bounded, redacted snapshot safe for the admin-authenticated route. */
export function buildDiagnosticsPayload(
  options: DiagnosticsOptions = {},
): Record<string, unknown> {
  const boot = options.startedAt ?? startedAt
  const payload = {
    status: "ok",
    version: {
      name: "@jeffreycao/copilot-api",
      version: getPackageVersion(),
      runtime: typeof Bun !== "undefined" ? "bun" : "node",
      runtimeVersion:
        typeof Bun !== "undefined" ? Bun.version : process.version,
      platform: os.platform(),
      arch: os.arch(),
      pid: process.pid,
      startedAt: new Date(boot).toISOString(),
      uptimeSeconds: Math.max(0, Math.round((Date.now() - boot) / 1000)),
    },
    memory: process.memoryUsage(),
    ...(options.extra ? { extra: options.extra } : {}),
  }
  return sanitizeForDiagnostics(payload) as Record<string, unknown>
}
