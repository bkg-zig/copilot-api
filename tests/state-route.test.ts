import { expect, test } from "bun:test"

import { MemoryStateRepository } from "../src/lib/state/repository"
import {
  createStateRoutes,
  createStateAdminRoutes,
} from "../src/routes/state/route"

function app() {
  const repository = new MemoryStateRepository()
  return {
    repository,
    routes: createStateRoutes({ repository }),
    admin: createStateAdminRoutes({ repository }),
  }
}

test("GET /v1/state/:repo_id returns state null for unknown repo", async () => {
  const { routes } = app()
  const res = await routes.request("/v1/state/proj_0123456789abcdef01234567", {
    method: "GET",
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { state: null }
  expect(body.state).toBeNull()
})

test("PUT then GET roundtrip bumps revision", async () => {
  const { routes } = app()
  const put = await routes.request("/v1/state/proj_0123456789abcdef01234567", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch: "main", goal: "ship it" }),
  })
  expect(put.status).toBe(200)
  const putBody = (await put.json()) as {
    state: { revision: number; branch: string }
  }
  expect(putBody.state.revision).toBe(1)
  expect(putBody.state.branch).toBe("main")

  const get = await routes.request("/v1/state/proj_0123456789abcdef01234567", {
    method: "GET",
  })
  const getBody = (await get.json()) as { state: { goal: string } }
  expect(getBody.state.goal).toBe("ship it")
})

test("PUT rejects invalid repo id", async () => {
  const { routes } = app()
  const res = await routes.request("/v1/state/not-valid", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch: "x" }),
  })
  expect(res.status).toBe(400)
})

test("POST /v1/events appends and triggers deterministic blueprint on resolved decision", async () => {
  const { routes } = app()
  const res = await routes.request("/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo_id: "proj_0123456789abcdef01234567",
      kind: "decision",
      summary: "Switched storage to Postgres with pgvector search",
      detail: {
        problem: "sqlite search too slow",
        solution: "postgres pgvector hnsw",
      },
      tech_stack: ["postgres", "pgvector"],
      resolved: true,
    }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    event: { id: number }
    blueprint: { title: string } | null
  }
  expect(typeof body.event.id).toBe("number")
  expect(body.blueprint).not.toBeNull()

  const search = await routes.request("/v1/blueprints/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tech_stack: ["postgres"], query: "pgvector" }),
  })
  expect(search.status).toBe(200)
  const searchBody = (await search.json()) as { blueprints: unknown[] }
  expect(searchBody.blueprints.length).toBeGreaterThan(0)
})

test("GET /v1/events/:repo_id lists events", async () => {
  const { routes } = app()
  await routes.request("/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo_id: "proj_0123456789abcdef01234567",
      kind: "step",
      summary: "did a step",
    }),
  })
  const res = await routes.request("/v1/events/proj_0123456789abcdef01234567", {
    method: "GET",
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { events: unknown[] }
  expect(body.events.length).toBe(1)
})

test("GET /v1/bootstrap/:repo_id returns markdown package", async () => {
  const { routes } = app()
  await routes.request("/v1/state/proj_0123456789abcdef01234567", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch: "feat/state", goal: "bootstrap" }),
  })
  const res = await routes.request(
    "/v1/bootstrap/proj_0123456789abcdef01234567",
    { method: "GET" },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { markdown: string }
  expect(body.markdown).toContain("# Bootstrap")
  expect(body.markdown).toContain("feat/state")
})

test("admin routes list and delete", async () => {
  const { routes, admin } = app()
  await routes.request("/v1/state/proj_0123456789abcdef01234567", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch: "main" }),
  })
  const list = await admin.request("/state/repos", { method: "GET" })
  expect(list.status).toBe(200)
  const listBody = (await list.json()) as { repos: string[] }
  expect(listBody.repos).toContain("proj_0123456789abcdef01234567")

  const del = await admin.request("/state/proj_0123456789abcdef01234567", {
    method: "DELETE",
  })
  expect(del.status).toBe(200)
  const list2 = await admin.request("/state/repos", { method: "GET" })
  const listBody2 = (await list2.json()) as { repos: string[] }
  expect(listBody2.repos).not.toContain("proj_0123456789abcdef01234567")
})
