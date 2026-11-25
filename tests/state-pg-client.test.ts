/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/await-thenable -- async test doubles */
import "./pg-mock-preload"

import { afterEach, expect, test } from "bun:test"

import { getConfig } from "~/lib/config"
import type { StateConfig } from "~/lib/state/config"

// Loaded dynamically: static imports would bind the real driver before the mock.
const { closePgClient, getPgClient, pgAvailable } =
  await import("~/lib/pg/client")
const { getStateRepository, resetStateStoreForTesting } =
  await import("~/lib/state/index")
const { PgStateStore } = await import("~/lib/state/store")

const originalUrl = process.env.SUPABASE_DB_URL
const originalFile = process.env.SUPABASE_DB_URL_FILE

function restoreEnv(): void {
  if (originalUrl === undefined) delete process.env.SUPABASE_DB_URL
  else process.env.SUPABASE_DB_URL = originalUrl
  if (originalFile === undefined) delete process.env.SUPABASE_DB_URL_FILE
  else process.env.SUPABASE_DB_URL_FILE = originalFile
}

async function resetClient(): Promise<void> {
  await closePgClient()
}

async function withState(
  patch: Partial<StateConfig>,
  body: () => Promise<void>,
): Promise<void> {
  const config = getConfig()
  const previous = config.state
  config.state = { ...previous, ...patch }
  try {
    await body()
  } finally {
    config.state = previous
  }
}

afterEach(async () => {
  restoreEnv()
  await resetClient()
  resetStateStoreForTesting()
})

test("pg client is absent until a url is configured", async () => {
  delete process.env.SUPABASE_DB_URL
  delete process.env.SUPABASE_DB_URL_FILE
  await resetClient()
  expect(getPgClient()).toBeNull()
  expect(getPgClient()).toBeNull()
  expect(pgAvailable()).toBe(false)
  await closePgClient()
  expect(pgAvailable()).toBe(false)
})

test("pg client reads SUPABASE_DB_URL and caches the connection", async () => {
  delete process.env.SUPABASE_DB_URL_FILE
  process.env.SUPABASE_DB_URL = "postgres://unit/cache"
  await resetClient()
  const first = getPgClient()
  expect(first).not.toBeNull()
  expect(getPgClient()).toBe(first)
  expect(pgAvailable()).toBe(true)
  await closePgClient()
  expect(getPgClient()).not.toBe(first)
})

test("pg client prefers the direct url over a file", async () => {
  process.env.SUPABASE_DB_URL_FILE = "/tmp/copilot-state-url-missing"
  process.env.SUPABASE_DB_URL = "  postgres://unit/direct  "
  await resetClient()
  expect(getPgClient()).not.toBeNull()
})

test("pg client reads a url file and ignores a missing file", async () => {
  delete process.env.SUPABASE_DB_URL
  const path = `/tmp/copilot-state-url-${Date.now()}`
  await Bun.write(path, "  postgres://unit/from-file  \n")
  process.env.SUPABASE_DB_URL_FILE = path
  await resetClient()
  expect(getPgClient()).not.toBeNull()
  await closePgClient()

  process.env.SUPABASE_DB_URL_FILE = "/tmp/copilot-state-url-does-not-exist"
  expect(getPgClient()).toBeNull()
  await closePgClient()

  process.env.SUPABASE_DB_URL_FILE = "/tmp"
  expect(getPgClient()).toBeNull()
})

test("pg client treats a constructor failure as unavailable", async () => {
  delete process.env.SUPABASE_DB_URL_FILE
  process.env.SUPABASE_DB_URL = "postgres://unit/throw-ctor"
  await resetClient()
  expect(getPgClient()).toBeNull()
  expect(pgAvailable()).toBe(false)
})

test("closing the client ignores end() failures", async () => {
  delete process.env.SUPABASE_DB_URL_FILE
  process.env.SUPABASE_DB_URL = "postgres://unit/end-throws"
  await resetClient()
  expect(getPgClient()).not.toBeNull()
  await closePgClient()
  delete process.env.SUPABASE_DB_URL
  expect(pgAvailable()).toBe(false)
})

test("state repository follows enabled flag and pg availability", async () => {
  delete process.env.SUPABASE_DB_URL_FILE
  delete process.env.SUPABASE_DB_URL
  await resetClient()
  resetStateStoreForTesting()
  expect(getStateRepository()).toBeNull()

  process.env.SUPABASE_DB_URL = "postgres://unit/repository"
  await resetClient()
  await withState({ enabled: false }, async () => {
    expect(getStateRepository()).toBeNull()
  })
  await withState({ enabled: true }, async () => {
    const first = getStateRepository()
    expect(first).not.toBeNull()
    expect(getStateRepository()).toBe(first)
    resetStateStoreForTesting()
    expect(getStateRepository()).not.toBe(first)
  })
})

test("PgStateStore round-trips state, events, and blueprints", async () => {
  delete process.env.SUPABASE_DB_URL_FILE
  process.env.SUPABASE_DB_URL = "postgres://unit/store"
  await resetClient()
  const store = new PgStateStore()
  const repoId = "proj_0123456789abcdef01234567"
  expect(await store.getState(repoId)).toBeNull()
  const created = await store.putState(repoId, {
    branch: "main",
    goal: "ship",
    completed_steps: ["one"],
    tech_stack: ["postgres"],
  })
  expect(created.revision).toBe(1)
  expect(created.goal).toBe("ship")
  const updated = await store.putState(repoId, { branch: "feat" })
  expect(updated.branch).toBe("feat")
  expect(updated.goal).toBe("ship")
  expect(updated.revision).toBe(2)
  expect((await store.getState(repoId))?.branch).toBe("feat")

  const event = await store.appendEvent({
    repo_id: repoId,
    kind: "step",
    summary: "did it",
    tech_stack: ["postgres"],
  })
  expect(event.id).toBeGreaterThan(0)
  expect(event.resolved).toBe(false)
  expect((await store.listEvents(repoId)).length).toBe(1)
  expect((await store.listEvents(repoId, "step")).length).toBe(1)
  expect((await store.listEvents(repoId, "error")).length).toBe(0)

  const blueprint = await store.addBlueprint({
    title: "Use pgvector",
    problem: "search",
    solution: "hnsw",
    tech_stack: ["postgres"],
    tokens: ["pgvector"],
    source_repo: repoId,
    origin: "deterministic",
    embedding: [0.1, 0.2],
  })
  expect(blueprint.id).toBeGreaterThan(0)
  expect(
    (await store.searchBlueprints({ embedding: [0.1, 0.2], limit: 2 })).length,
  ).toBeGreaterThan(0)
  expect(
    (
      await store.searchBlueprints({
        query: "pgvector",
        tech_stack: [" postgres "],
      })
    ).length,
  ).toBeGreaterThan(0)
  expect(
    (await store.searchBlueprints({ tech_stack: [], limit: 5 })).length,
  ).toBeGreaterThan(0)
  expect((await store.listBlueprints(10)).length).toBeGreaterThan(0)
  await store.bumpBlueprintUse(blueprint.id ?? 0)
  expect(await store.listRepos()).toContain(repoId)
  await store.deleteRepo(repoId)
  expect(await store.getState(repoId)).toBeNull()
  expect(await store.listEvents(repoId)).toEqual([])
})

test("schema install tolerates extension permission errors and skips when autoMigrate is off", async () => {
  delete process.env.SUPABASE_DB_URL_FILE
  process.env.SUPABASE_DB_URL = "postgres://unit/ext-denied"
  await resetClient()
  const denied = new PgStateStore()
  expect(await denied.ensureSchema()).toBe(true)
  expect(await denied.ensureSchema()).toBe(true)
  expect(await denied.getState("proj_ok")).toBeNull()

  process.env.SUPABASE_DB_URL = "postgres://unit/ext-fail"
  await resetClient()
  await expect(new PgStateStore().ensureSchema()).rejects.toThrow(
    /syntax error/,
  )

  process.env.SUPABASE_DB_URL = "postgres://unit/no-migrate"
  await resetClient()
  await withState({ autoMigrate: false }, async () => {
    const store = new PgStateStore()
    expect(await store.ensureSchema()).toBe(true)
    expect(await store.getState("proj_ok")).toBeNull()
  })
})

test("store methods no-op when postgres is unavailable", async () => {
  delete process.env.SUPABASE_DB_URL
  delete process.env.SUPABASE_DB_URL_FILE
  await resetClient()
  const store = new PgStateStore()
  expect(await store.ensureSchema()).toBe(false)
  expect(await store.getState("x")).toBeNull()
  await expect(store.putState("x", {})).rejects.toThrow("Postgres unavailable")
  await expect(
    store.appendEvent({ repo_id: "x", kind: "step", summary: "s" }),
  ).rejects.toThrow("Postgres unavailable")
  await expect(
    store.addBlueprint({
      title: "t",
      problem: "p",
      solution: "s",
      tech_stack: [],
      tokens: [],
      source_repo: "x",
      origin: "deterministic",
    }),
  ).rejects.toThrow("Postgres unavailable")
  expect(await store.listEvents("x")).toEqual([])
  expect(await store.searchBlueprints({})).toEqual([])
  expect(await store.listBlueprints()).toEqual([])
  await store.bumpBlueprintUse(1)
  await store.deleteRepo("x")
  expect(await store.listRepos()).toEqual([])
})

test("row parsers tolerate malformed postgres values", async () => {
  delete process.env.SUPABASE_DB_URL_FILE
  process.env.SUPABASE_DB_URL = "postgres://unit/parsers"
  await resetClient()
  const store = new PgStateStore()
  const state = await store.getState("__parser__")
  expect(state?.revision).toBe(3)
  expect(state?.completed_steps).toEqual([])
  expect(state?.active_files).toEqual(["f"])
  expect(state?.constraints).toEqual(["1"])
  expect(state?.updated_at).toBeUndefined()
  const events = await store.listEvents("__parser__")
  expect(events[0]?.resolved).toBe(true)
  expect(events[0]?.detail).toEqual({})
  const blueprint = await store.addBlueprint({
    title: "__parser__",
    problem: "p",
    solution: "s",
    tech_stack: [],
    tokens: [],
    source_repo: "x",
    origin: "model",
  })
  expect(blueprint.origin).toBe("model")
  expect(blueprint.source_event).toBeUndefined()
  expect(blueprint.tech_stack).toEqual([])
  expect(blueprint.tokens).toEqual([])
})
