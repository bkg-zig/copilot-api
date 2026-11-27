import { expect, test } from "bun:test"

import { PgStateStore } from "../src/lib/state/store"

const url = process.env.SUPABASE_DB_URL?.trim()
const describe = url ? test : test.skip

describe("PgStateStore roundtrip against SUPABASE_DB_URL", async () => {
  const repoId = "proj_0123456789abcdef01234567"
  const store = new PgStateStore()
  await store.ensureSchema()
  await store.deleteRepo(repoId)
  const state = await store.putState(repoId, {
    branch: "main",
    goal: "integration",
  })
  expect(state.revision).toBe(1)
  const read = await store.getState(repoId)
  expect(read?.goal).toBe("integration")
  const event = await store.appendEvent({
    repo_id: repoId,
    kind: "step",
    summary: "hello",
  })
  expect(event.id).toBeGreaterThan(0)
  const events = await store.listEvents(repoId)
  expect(events.length).toBeGreaterThan(0)
  await store.deleteRepo(repoId)
  expect(await store.getState(repoId)).toBeNull()
})
