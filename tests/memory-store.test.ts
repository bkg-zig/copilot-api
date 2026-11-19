import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildMemoryBlock } from "../src/lib/memory/block"
import { compactText } from "../src/lib/memory/hash"
import {
  closeMemoryStore,
  getMemoryDbPath,
  getMemoryStore,
  resetMemoryStoreForTesting,
} from "../src/lib/memory/index"
import { deriveProject, resolveProjectRef } from "../src/lib/memory/projects"
import { MemoryStore } from "../src/lib/memory/store"
import type { MemoryEntry } from "../src/lib/memory/types"

const dirs: Array<string> = []

function makeStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-memory-"))
  dirs.push(dir)
  return new MemoryStore(path.join(dir, "memory.sqlite"))
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

const context = (projectId: string, sessionId = "s1") => ({
  budget: 1200,
  maxKnowledge: 4,
  maxSteps: 6,
  projectId,
  sessionId,
})

function entry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    count: 1,
    createdAt: 0,
    hash: "h",
    id: "id",
    lastSeenAt: 0,
    pinned: false,
    projectId: "p",
    sessionCount: 1,
    sessionId: "s",
    source: "user",
    strength: 1,
    supersedes: null,
    text: "t",
    tier: "step",
    ...overrides,
  }
}

test("first user prompt becomes the pinned goal", async () => {
  const store = makeStore()
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Build the parser",
  })
  const block = await store.getContext(context("p1"))
  expect(block.goal).toBe("Build the parser")
  expect(block.text).toContain("Ziel: Build the parser")
  await store.close()
})

test("an explicit goal marker softly retires the previous goal", async () => {
  const store = makeStore()
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Start",
  })
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Ziel: Second",
  })
  const block = await store.getContext(context("p1"))
  expect(block.goal).toBe("Second")
  expect(block.previousGoal).toBe("Start")
  expect(block.text).toContain("Vorheriges Ziel: Start")
  await store.close()
})

test("identical content is deduplicated and boosted", async () => {
  const store = makeStore()
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s1",
    text: "ran tests",
  })
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s1",
    text: "ran   tests",
  })
  const entries = await store.getEntries("p1", { tier: "step" })
  expect(entries).toHaveLength(1)
  expect(entries[0].count).toBe(2)
  expect(entries[0].strength).toBe(1.5)
  await store.close()
})

test("steps decay on every user turn and are forgotten below the floor", async () => {
  const store = makeStore()
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Main goal",
  })
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s1",
    text: "a tool step",
  })
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "turn two",
  })
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "turn three",
  })
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "turn four",
  })
  const entries = await store.getEntries("p1", { tier: "step" })
  const step = entries.find((value) => value.text === "a tool step")
  expect(step?.strength).toBe(0)
  const block = await store.getContext(context("p1"))
  expect(block.text).not.toContain("a tool step")
  await store.close()
})

test("a step repeated three times becomes procedural", async () => {
  const store = makeStore()
  for (let index = 0; index < 3; index += 1) {
    await store.observe({
      kind: "tool",
      projectId: "p1",
      sessionId: "s1",
      text: "npm test",
    })
  }
  const entries = await store.getEntries("p1", { tier: "step" })
  expect(entries[0].count).toBe(3)
  const block = await store.getContext(context("p1"))
  expect(block.text).toContain("- Verfahren: npm test")
  await store.close()
})

test("a subagent assignment does not replace the goal", async () => {
  const store = makeStore()
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Main goal",
  })
  await store.observe({
    kind: "subagent",
    projectId: "p1",
    sessionId: "s1",
    text: "Research X",
  })
  const block = await store.getContext(context("p1"))
  expect(block.goal).toBe("Main goal")
  expect(block.text).toContain("- Auftrag: Research X")
  await store.close()
})

test("projects are isolated rooms", async () => {
  const store = makeStore()
  await store.observe({
    kind: "user",
    projectId: "pa",
    sessionId: "s1",
    text: "Goal A",
  })
  const other = await store.getContext(context("pb"))
  expect(other.goal).toBeNull()
  expect(other.text).toBe("")
  await store.close()
})

test("semantic markers survive as knowledge entries", async () => {
  const store = makeStore()
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Ziel: Ship it",
  })
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Decision: use SQLite",
  })
  const entries = await store.getEntries("p1", { tier: "semantic" })
  expect(entries.map((value) => value.text)).toEqual(["use SQLite"])
  await store.close()
})

test("compact removes forgotten entries but keeps the goal", async () => {
  const store = makeStore()
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Main goal",
  })
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s1",
    text: "transient",
  })
  for (let index = 0; index < 4; index += 1) {
    await store.observe({
      kind: "user",
      projectId: "p1",
      sessionId: "s1",
      text: `turn ${index}`,
    })
  }
  const removed = await store.compact("p1")
  expect(removed).toBeGreaterThan(0)
  const remaining = await store.getEntries("p1")
  expect(remaining.some((value) => value.tier === "goal")).toBe(true)
  expect(remaining.some((value) => value.text === "transient")).toBe(false)
  await store.close()
})

test("deleteProject drops every row for that room", async () => {
  const store = makeStore()
  await store.ensureProject({ id: "p1", name: "p1", remote: "", root: "" })
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Goal",
  })
  expect(await store.deleteProject("p1")).toBe(true)
  expect(await store.getEntries("p1")).toEqual([])
  expect(await store.deleteProject("p1")).toBe(false)
  await store.close()
})

test("the working block respects the character budget", () => {
  const long = "x".repeat(80)
  const entries: Array<MemoryEntry> = [
    entry({ id: "g", tier: "goal", pinned: true, text: "Goal" }),
    entry({ id: "1", strength: 3, text: long }),
    entry({ id: "2", strength: 2, text: long }),
    entry({ id: "3", strength: 1, text: long }),
  ]
  const block = buildMemoryBlock({
    entries,
    options: { budget: 120, maxKnowledge: 4, maxSteps: 6 },
    projectId: "p1",
    sessionId: "s",
  })
  expect(block.truncated).toBe(true)
  expect(block.usedIds).toContain("g")
  expect(block.lines.length).toBeLessThan(3)
})

test("equal-strength entries are ordered by recency", () => {
  const entries: Array<MemoryEntry> = [
    entry({ id: "old", lastSeenAt: 1, text: "old" }),
    entry({ id: "new", lastSeenAt: 2, text: "new" }),
  ]
  const block = buildMemoryBlock({
    entries,
    options: { budget: 1000, maxKnowledge: 4, maxSteps: 6 },
    projectId: "p",
    sessionId: "s",
  })
  expect(block.lines[0]).toContain("new")
})

test("compactText bounds long text", () => {
  expect(compactText("hello world", 5)).toBe("hell…")
})

test("listProjects returns registered rooms", async () => {
  const store = makeStore()
  await store.ensureProject({
    id: "p1",
    name: "Alpha",
    remote: "git@example/x",
    root: "/x",
  })
  await store.ensureProject({ id: "p2", name: "Beta", remote: "", root: "" })
  const projects = await store.listProjects()
  expect(projects.map((value) => value.name).sort()).toEqual(["Alpha", "Beta"])
  expect(projects.find((value) => value.id === "p1")?.remote).toBe(
    "git@example/x",
  )
  await store.close()
})

test("observe handles goal, semantic and summary kinds directly", async () => {
  const store = makeStore()
  await store.observe({
    kind: "goal",
    projectId: "p1",
    sessionId: "s1",
    text: "Direct goal",
  })
  await store.observe({
    kind: "semantic",
    projectId: "p1",
    sessionId: "s1",
    text: "Fact: x",
  })
  await store.observe({
    kind: "summary",
    projectId: "p1",
    sessionId: "s1",
    text: "Did a lot",
  })
  // Re-stating the same goal refreshes it instead of duplicating it.
  await store.observe({
    kind: "user",
    projectId: "p1",
    sessionId: "s1",
    text: "Goal: Direct goal",
  })
  const block = await store.getContext(context("p1"))
  expect(block.goal).toBe("Direct goal")
  const tiers = (await store.getEntries("p1")).map((value) => value.tier)
  expect(tiers).toContain("semantic")
  expect(tiers).toContain("step")
  await store.close()
})

test("session_count grows when a different session repeats content", async () => {
  const store = makeStore()
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s1",
    text: "shared",
  })
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s2",
    text: "shared",
  })
  const entries = await store.getEntries("p1", { tier: "step" })
  expect(entries[0].count).toBe(2)
  expect(entries[0].sessionCount).toBe(2)
  await store.close()
})

test("getEntries filters by session", async () => {
  const store = makeStore()
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s1",
    text: "one",
  })
  await store.observe({
    kind: "tool",
    projectId: "p1",
    sessionId: "s2",
    text: "two",
  })
  const onlyS1 = await store.getEntries("p1", { sessionId: "s1" })
  expect(onlyS1.map((value) => value.text)).toEqual(["one"])
  await store.close()
})

test("compact without a project prunes across rooms", async () => {
  const store = makeStore()
  for (let index = 0; index < 4; index += 1) {
    await store.observe({
      kind: "tool",
      projectId: "p1",
      sessionId: "s1",
      text: `t${index}`,
    })
    await store.observe({
      kind: "user",
      projectId: "p1",
      sessionId: "s1",
      text: `turn ${index}`,
    })
  }
  const removed = await store.compact()
  expect(removed).toBeGreaterThan(0)
  await store.close()
})

test("resolveProjectRef derives stable ids", () => {
  const byName1 = resolveProjectRef("my-project")
  const byName2 = resolveProjectRef("my-project")
  expect(byName1.id).toBe(byName2.id)
  expect(byName1.name).toBe("my-project")
  expect(resolveProjectRef(byName1.id).id).toBe(byName1.id)
  expect(deriveProject(process.cwd()).id.startsWith("proj_")).toBe(true)
})

test("getMemoryDbPath honours the sqlite env override", () => {
  const previous = process.env.COPILOT_API_SQLITE_DB_PATH
  process.env.COPILOT_API_SQLITE_DB_PATH = "/tmp/custom-memory.sqlite"
  try {
    expect(getMemoryDbPath()).toBe("/tmp/custom-memory.sqlite")
  } finally {
    if (previous === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
    else process.env.COPILOT_API_SQLITE_DB_PATH = previous
  }
})

test("the singleton store opens, registers and closes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-memory-single-"))
  dirs.push(dir)
  const previous = process.env.COPILOT_API_SQLITE_DB_PATH
  process.env.COPILOT_API_SQLITE_DB_PATH = path.join(dir, "singleton.sqlite")
  try {
    resetMemoryStoreForTesting()
    const store = getMemoryStore()
    await store.ensureProject({ id: "p1", name: "Solo", remote: "", root: "" })
    expect((await store.listProjects()).length).toBe(1)
    await closeMemoryStore()
  } finally {
    resetMemoryStoreForTesting()
    if (previous === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
    else process.env.COPILOT_API_SQLITE_DB_PATH = previous
  }
})
