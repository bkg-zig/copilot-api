import { describe, expect, test } from "bun:test"

import { buildDiagnosticsPayload, buildHealthPayload } from "~/lib/diagnostics"
import { createServer } from "~/server"

describe("health payload", () => {
  test("reports only non-sensitive liveness fields", () => {
    const payload = buildHealthPayload(1_700_000_000_000)

    expect(payload.status).toBe("ok")
    expect(payload.timestamp).toBe("2023-11-14T22:13:20.000Z")
    expect(payload.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(payload)).not.toMatch(/token|apiKey|secret/i)
  })

  test("diagnostics payload is bounded and redacted", () => {
    const payload = buildDiagnosticsPayload({
      startedAt: 1_700_000_000_000,
      extra: { refreshToken: "do-not-leak-me", model: "gpt-5" },
    })

    expect(payload.status).toBe("ok")
    expect(JSON.stringify(payload)).not.toContain("do-not-leak-me")
    expect(JSON.stringify(payload)).toContain("gpt-5")
  })
})

describe("health route", () => {
  test("GET /health is public even when gateway api keys are configured", async () => {
    const app = createServer({ getApiKeys: () => ["gateway-key"] })

    const response = await app.request("http://localhost/health")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string }
    expect(body.status).toBe("ok")
  })

  test("GET /v1/health matches /health", async () => {
    const app = createServer()

    const response = await app.request("http://localhost/v1/health")

    expect(response.status).toBe(200)
  })

  test("GET /admin/diagnostics requires admin authentication", async () => {
    const app = createServer({ getApiKeys: () => ["gateway-key"] })

    const response = await app.request("http://localhost/admin/diagnostics")

    expect(response.status).toBe(401)
  })
})
