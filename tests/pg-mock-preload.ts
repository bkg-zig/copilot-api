/* eslint-disable @typescript-eslint/no-floating-promises -- async test doubles */
import { mock } from "bun:test"

/**
 * In-memory stand-in for the `postgres` driver. Unit tests cover the state
 * owner without opening a database connection. The integration test does not
 * load this preload.
 */
type Row = Record<string, unknown>

interface MemoryDb {
  states: Map<string, Row>
  events: Row[]
  blueprints: Row[]
  nextEventId: number
  nextBlueprintId: number
  extension: "ok" | "denied" | "fail"
}

const databases = new Map<string, MemoryDb>()

function databaseFor(url: string): MemoryDb {
  const existing = databases.get(url)
  if (existing) return existing
  const extension: MemoryDb["extension"] =
    url.includes("ext-denied") ? "denied"
    : url.includes("ext-fail") ? "fail"
    : "ok"
  const created: MemoryDb = {
    states: new Map(),
    events: [],
    blueprints: [],
    nextEventId: 1,
    nextBlueprintId: 1,
    extension,
  }
  databases.set(url, created)
  return created
}

function textOf(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/g, " ").trim()
}

function parserState(repoId: string): Row {
  return {
    repo_id: repoId,
    git_remote_url: 12,
    branch: "b",
    commit_sha: null,
    goal: "g",
    completed_steps: "{bad",
    pending_steps: { a: 1 },
    failed_attempts: "null",
    active_files: '["f"]',
    constraints: "[1]",
    tech_stack: '["ts"]',
    last_model: "m",
    session_id: "s",
    revision: "3",
    created_at: "2020-01-01T00:00:00.000Z",
    updated_at: "",
  }
}

function parserEvent(repoId: string): Row {
  return {
    id: "nope",
    repo_id: repoId,
    session_id: 4,
    kind: "step",
    summary: null,
    detail: "{bad",
    tech_stack: { a: 1 },
    resolved: 1,
    created_at: "2020-01-01T00:00:00.000Z",
  }
}

function parserBlueprint(): Row {
  return {
    id: "nope",
    title: 1,
    problem: null,
    solution: null,
    tech_stack: "not-json",
    tokens: "{}",
    source_repo: null,
    source_event: null,
    origin: "model",
    use_count: "nope",
  }
}

function query(db: MemoryDb, text: string, values: unknown[]): Row[] {
  if (text.includes("DELETE FROM repo_event_log")) {
    db.events = db.events.filter((row) => row.repo_id !== values[0])
    return []
  }
  if (text.includes("DELETE FROM repo_working_state")) {
    db.states.delete(String(values[0]))
    return []
  }
  if (text.includes("UPDATE cross_repo_blueprints")) {
    const found = db.blueprints.find((row) => row.id === values[0])
    if (found) found.use_count = Number(found.use_count) + 1
    return []
  }
  if (text.includes("INSERT INTO repo_working_state")) {
    const row: Row = {
      repo_id: values[0],
      git_remote_url: values[1],
      branch: values[2],
      commit_sha: values[3],
      goal: values[4],
      completed_steps: values[5],
      pending_steps: values[6],
      failed_attempts: values[7],
      active_files: values[8],
      constraints: values[9],
      tech_stack: values[10],
      last_model: values[11],
      session_id: values[12],
      revision: values[13],
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("not-a-date"),
    }
    db.states.set(String(values[0]), row)
    return [row]
  }
  if (text.includes("FROM repo_working_state WHERE")) {
    const repoId = String(values[0])
    if (repoId === "__parser__") return [parserState(repoId)]
    const row = db.states.get(repoId)
    return row ? [row] : []
  }
  if (text.includes("INSERT INTO repo_event_log")) {
    if (values[3] === "__parser__") return [parserEvent(String(values[0]))]
    const row: Row = {
      id: db.nextEventId++,
      repo_id: values[0],
      session_id: values[1],
      kind: values[2],
      summary: values[3],
      detail: values[4],
      tech_stack: values[5],
      resolved: values[6],
      created_at: "2026-01-01T00:00:00.000Z",
    }
    db.events.push(row)
    return [row]
  }
  if (text.includes("FROM repo_event_log")) {
    const repoId = String(values[0])
    if (repoId === "__parser__") return [parserEvent(repoId)]
    const kind = text.includes("kind =") ? String(values[1]) : undefined
    const limit = Number(kind ? values[2] : values[1])
    return db.events
      .filter(
        (row) => row.repo_id === repoId && (kind ? row.kind === kind : true),
      )
      .slice(0, Number.isFinite(limit) ? limit : 50)
  }
  if (text.includes("INSERT INTO cross_repo_blueprints")) {
    if (values[0] === "__parser__") return [parserBlueprint()]
    const row: Row = {
      id: db.nextBlueprintId++,
      title: values[0],
      problem: values[1],
      solution: values[2],
      tech_stack: values[3],
      tokens: values[4],
      source_repo: values[5],
      source_event: values[6],
      origin: values[7],
      embedding: values[8],
      use_count: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }
    db.blueprints.push(row)
    return [row]
  }
  if (
    text.includes("embedding <=>")
    || text.includes("ts_rank")
    || (text.includes("FROM cross_repo_blueprints")
      && text.includes("use_count DESC"))
  ) {
    return db.blueprints.slice(0, Number(values.at(-1)) || db.blueprints.length)
  }
  if (text.includes("SELECT repo_id FROM repo_working_state")) {
    return [...db.states.keys()].sort().map((repoId) => ({ repo_id: repoId }))
  }
  if (text.includes("ORDER BY updated_at DESC")) {
    const limit = Number(values[0])
    return db.blueprints.slice(0, Number.isFinite(limit) ? limit : 20)
  }
  throw new Error(`Unrecognized state SQL: ${text}`)
}

function fakePostgres(url: string) {
  if (url.includes("throw-ctor")) {
    throw new Error("cannot connect")
  }
  const db = databaseFor(url)
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(query(db, textOf(strings), values))
  return Object.assign(sql, {
    unsafe(statement: string) {
      if (statement.startsWith("CREATE EXTENSION")) {
        if (db.extension === "denied") {
          return Promise.reject(
            new Error("permission denied to create extension"),
          )
        }
        if (db.extension === "fail") {
          return Promise.reject(new Error("syntax error at or near vector"))
        }
      }
      return Promise.resolve([])
    },
    end() {
      if (url.includes("end-throws")) {
        return Promise.reject(new Error("end failed"))
      }
      return Promise.resolve()
    },
  })
}

mock.module("postgres", () => ({
  default: fakePostgres,
}))
