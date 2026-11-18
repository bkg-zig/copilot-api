import { Hono } from "hono"

import { buildDiagnosticsPayload } from "~/lib/diagnostics"

export const diagnosticsRoutes = new Hono()

// Mounted under /admin, so the admin auth middleware in server.ts guards it.
diagnosticsRoutes.get("/", (c) => {
  c.header("Cache-Control", "no-store")
  return c.json(buildDiagnosticsPayload())
})
