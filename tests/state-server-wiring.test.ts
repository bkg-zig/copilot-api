import { expect, test } from "bun:test"

import { createServer } from "../src/server"

test("createServer mounts the public state route", async () => {
  const app = createServer({ getApiKeys: () => [] })
  const response = await app.request("/v1/state/proj_0123456789abcdef01234567")
  expect(response.status).toBe(200)
  const body = (await response.json()) as { repo_id: string; state: unknown }
  expect(body.repo_id).toBe("proj_0123456789abcdef01234567")
  expect(body.state).toBeNull()
})
