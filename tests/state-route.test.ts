/* eslint-disable @typescript-eslint/require-await -- async test doubles */
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getConfig } from "~/lib/config"
import { MemoryStateRepository } from "../src/lib/state/repository"
import {
  createStateRoutes,
  createStateAdminRoutes,
} from "../src/routes/state/route"

import type { Blueprint } from "../src/lib/state/types"

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

const repoId = "proj_0123456789abcdef01234567"

test("state routes reject bad ids, bodies, and a missing store", async () => {
  const { routes } = app()
  const badGet = await routes.request("/v1/state/not-a-repo")
  expect(badGet.status).toBe(400)

  const badPut = await routes.request(`/v1/state/${repoId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "null",
  })
  expect(badPut.status).toBe(400)

  const listed = await routes.request(`/api/v1/state/${repoId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      branch: "main",
      completed_steps: ["one", "one", "  "],
      pending_steps: ["two"],
    }),
  })
  expect(listed.status).toBe(200)
  const listedBody = (await listed.json()) as {
    state: { completed_steps: string[] }
  }
  expect(listedBody.state.completed_steps).toEqual(["one"])

  const missingStore = createStateRoutes({ getRepository: () => null })
  expect((await missingStore.request(`/v1/state/${repoId}`)).status).toBe(200)
  expect(
    (
      await missingStore.request(`/v1/state/${repoId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: "x" }),
      })
    ).status,
  ).toBe(503)
  expect(
    (
      await missingStore.request("/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await missingStore.request("/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "step", summary: "x" }),
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await missingStore.request("/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo_id: repoId, kind: "nope", summary: "x" }),
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await missingStore.request("/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo_id: repoId, kind: "step", summary: "  " }),
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await missingStore.request("/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo_id: repoId,
          kind: "step",
          summary: "saved",
        }),
      })
    ).status,
  ).toBe(503)
  const noEvents = (await (
    await missingStore.request(`/v1/events/${repoId}`)
  ).json()) as { events: unknown[] }
  expect(noEvents.events).toEqual([])
  expect(
    (
      await missingStore.request("/v1/blueprints/search", {
        method: "POST",
        body: "null",
        headers: { "content-type": "application/json" },
      })
    ).status,
  ).toBe(400)
  const noBlueprints = (await (
    await missingStore.request("/v1/blueprints/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    })
  ).json()) as { blueprints: unknown[] }
  expect(noBlueprints.blueprints).toEqual([])
  const listedBlueprints = (await (
    await missingStore.request("/v1/blueprints")
  ).json()) as { blueprints: unknown[] }
  expect(listedBlueprints.blueprints).toEqual([])
  const admin = createStateAdminRoutes({ getRepository: () => null })
  expect(
    (await admin.request(`/state/${repoId}`, { method: "DELETE" })).status,
  ).toBe(503)
})

test("events accept a free-form repo name and bootstrap reads constraint files", async () => {
  const { routes } = app()
  const created = await routes.request("/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo_id: "memory-room",
      kind: "goal",
      summary: "track the room",
      detail: "not-an-object",
      resolved: false,
    }),
  })
  expect(created.status).toBe(200)
  const createdBody = (await created.json()) as {
    event: { repo_id: string }
    blueprint: unknown
  }
  expect(createdBody.event.repo_id).toMatch(/^proj_[0-9a-f]{24}$/)
  expect(createdBody.blueprint).toBeNull()

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-bootstrap-"))
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    "# Rules\n- keep tests\nplain line\n",
  )
  fs.writeFileSync(path.join(dir, "CONSTRAINTS.md"), "- no secrets\n")
  const bootstrap = await routes.request(
    `/v1/bootstrap/${repoId}?include_blueprints=false&path=${encodeURIComponent(dir)}`,
  )
  expect(bootstrap.status).toBe(200)
  const body = (await bootstrap.json()) as { markdown: string }
  // A client-supplied path must never make the server read files.
  expect(body.markdown).not.toContain("- keep tests")
  expect(body.markdown).not.toContain("- no secrets")

  const kind = await routes.request(
    `/v1/events/${createdBody.event.repo_id}?kind=goal&limit=1`,
  )
  const kindBody = (await kind.json()) as { events: Array<{ kind: string }> }
  expect(kindBody.events.map((event) => event.kind)).toEqual(["goal"])

  const blueprints = await routes.request("/api/v1/blueprints?limit=5")
  expect(blueprints.status).toBe(200)
})

test("optional model extraction records a blueprint and ignores extractor failures", async () => {
  const repository = new MemoryStateRepository()
  let modelCalls = 0
  const original = repository.addBlueprint.bind(repository)
  repository.addBlueprint = async (input: Blueprint) => {
    if (input.origin === "model") {
      modelCalls += 1
      if (modelCalls === 1) throw new Error("extractor failed")
    }
    return original(input)
  }
  const routes = createStateRoutes({ repository })
  const config = getConfig()
  const previous = config.state
  config.state = {
    ...previous,
    extractorModel: "extractor",
    allowMeteredExtraction: true,
  }
  try {
    const first = await routes.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        kind: "step",
        summary: "a resolved step worth extracting",
        resolved: true,
      }),
    })
    expect(first.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(modelCalls).toBe(1)

    const second = await routes.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_id: repoId,
        kind: "tool",
        summary: "second resolved step",
        resolved: true,
      }),
    })
    expect(second.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(modelCalls).toBe(2)
    const saved = await repository.listBlueprints()
    expect(saved.some((blueprint) => blueprint.origin === "model")).toBe(true)
  } finally {
    config.state = previous
  }
})

test("getState failure is reported as an empty state", async () => {
  const repository = new MemoryStateRepository()
  repository.getState = async () => {
    throw new Error("down")
  }
  const routes = createStateRoutes({ repository })
  const response = await routes.request(`/v1/state/${repoId}`)
  expect(response.status).toBe(200)
  const body = (await response.json()) as { state: null }
  expect(body.state).toBeNull()

  const admin = createStateAdminRoutes({ repository })
  await repository.putState("proj_aaaaaaaaaaaaaaaaaaaaaaaa", { branch: "a" })
  repository.getState = async () => {
    throw new Error("down")
  }
  const list = await admin.request("/state/repos")
  const listBody = (await list.json()) as { states: Array<null> }
  expect(listBody.states).toEqual([null])
})
