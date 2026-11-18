import { Hono } from "hono"

import { buildHealthPayload } from "~/lib/diagnostics"

export const healthRoutes = new Hono()

healthRoutes.get("/", (c) => {
  c.header("Cache-Control", "no-store")
  return c.json(buildHealthPayload())
})
