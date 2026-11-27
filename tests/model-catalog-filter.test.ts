import { expect, test } from "bun:test"

import { filterModelCatalog } from "~/lib/http/model-catalog-filter"
import type { GatewayApiKeyConfig } from "~/lib/types/api-key"

const restricted: GatewayApiKeyConfig = {
  id: "restricted",
  key: "unused-secret",
  allowedModels: ["bkg-api/*"],
}

const unrestricted: GatewayApiKeyConfig = {
  id: "unrestricted",
  key: "unused-secret",
}

test("filters OpenAI-style model discovery data by allowedModels", async () => {
  const response = Response.json({
    object: "list",
    data: [{ id: "bkg-api/one" }, { id: "other/two" }, { id: "bkg-api/three" }],
  })

  const result = await filterModelCatalog(response, restricted)
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({
    object: "list",
    data: [{ id: "bkg-api/one" }, { id: "bkg-api/three" }],
  })
})

test("filters Codex-style model discovery models by slug", async () => {
  const response = Response.json({
    models: [{ slug: "bkg-api/one" }, { slug: "codex/two" }],
  })

  const result = await filterModelCatalog(response, restricted)
  expect(await result.json()).toEqual({
    models: [{ slug: "bkg-api/one" }],
  })
})

test("leaves unrestricted, non-JSON and failed responses untouched", async () => {
  const open = Response.json({ data: [{ id: "other/two" }] })
  expect(await filterModelCatalog(open, unrestricted)).toBe(open)

  const text = new Response("plain text")
  expect(await filterModelCatalog(text, restricted)).toBe(text)

  const failed = Response.json({ data: [{ id: "other/two" }] }, { status: 502 })
  expect(await filterModelCatalog(failed, restricted)).toBe(failed)
})
