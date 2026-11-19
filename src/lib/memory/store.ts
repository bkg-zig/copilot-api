import { randomUUID } from "node:crypto"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { SqliteDbStore, type SqliteDatabase } from "~/lib/sqlite"

import { buildMemoryBlock } from "./block"
import {
  BOOST,
  DECAY_PER_TURN,
  FORGET_FLOOR,
  GOAL_MARKER,
  GOAL_MAX_CHARS,
  INITIAL_STRENGTH,
  MAX_STRENGTH,
  PROCEDURAL_THRESHOLD,
  SEMANTIC_MARKER,
  STEP_MAX_CHARS,
} from "./constants"
import { compactText, contentHash, normalizeText } from "./hash"
import type { ResolvedProject } from "./projects"
import type {
  MemoryBlock,
  MemoryContextInput,
  MemoryEntry,
  MemoryObserveInput,
  MemoryProject,
  MemorySource,
  MemoryTier,
} from "./types"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const DEFAULT_DB_FILENAME = "copilot-api.sqlite"

interface MemoryEntryRow {
  id: string
  project_id: string
  session_id: string
  tier: string
  text: string
  hash: string
  count: number
  strength: number
  created_at_ms: number
  last_seen_at_ms: number
  pinned: number
  supersedes: string | null
  source: string
  session_count: number
}

interface MemoryProjectRow {
  id: string
  name: string
  root: string
  remote: string
  created_at_ms: number
  updated_at_ms: number
}

export function getMemoryDbPath(): string {
  return (
    process.env[DB_PATH_ENV] ?? path.join(PATHS.APP_DIR, DEFAULT_DB_FILENAME)
  )
}

function initializeMemoryDb(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      strength REAL NOT NULL,
      created_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      supersedes TEXT,
      source TEXT NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 1
    )
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_hash
    ON memory_entries(project_id, tier, hash)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_project
    ON memory_entries(project_id, pinned, strength)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entries_session
    ON memory_entries(project_id, session_id)
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root TEXT NOT NULL DEFAULT '',
      remote TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `)
}

function toEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    count: row.count,
    createdAt: row.created_at_ms,
    hash: row.hash,
    id: row.id,
    lastSeenAt: row.last_seen_at_ms,
    pinned: row.pinned === 1,
    projectId: row.project_id,
    sessionCount: row.session_count,
    sessionId: row.session_id,
    source: row.source as MemorySource,
    strength: row.strength,
    supersedes: row.supersedes,
    text: row.text,
    tier: row.tier as MemoryTier,
  }
}

function toProject(row: MemoryProjectRow): MemoryProject {
  return {
    createdAt: row.created_at_ms,
    id: row.id,
    name: row.name,
    remote: row.remote,
    root: row.root,
    updatedAt: row.updated_at_ms,
  }
}

function findEntry(
  db: SqliteDatabase,
  projectId: string,
  tier: MemoryTier,
  hash: string,
): MemoryEntryRow | undefined {
  return db
    .prepare(
      "SELECT * FROM memory_entries WHERE project_id = ? AND tier = ? AND hash = ?",
    )
    .get(projectId, tier, hash) as MemoryEntryRow | undefined
}

function findEntryById(
  db: SqliteDatabase,
  id: string,
): MemoryEntryRow | undefined {
  return db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as
    | MemoryEntryRow
    | undefined
}

function recordEntry(
  db: SqliteDatabase,
  input: {
    projectId: string
    sessionId: string
    tier: MemoryTier
    text: string
    source: MemorySource
    now: number
    pinned?: boolean
    supersedes?: string | null
  },
): MemoryEntry {
  const hash = contentHash(input.text)
  const existing = findEntry(db, input.projectId, input.tier, hash)
  if (existing) {
    const sessionCount =
      input.sessionId && existing.session_id !== input.sessionId ?
        existing.session_count + 1
      : existing.session_count
    db.prepare(
      `UPDATE memory_entries
         SET count = count + 1,
             strength = MIN(?, strength + ?),
             last_seen_at_ms = ?,
             session_id = ?,
             session_count = ?
       WHERE id = ?`,
    ).run(
      MAX_STRENGTH,
      BOOST,
      input.now,
      input.sessionId || existing.session_id,
      sessionCount,
      existing.id,
    )
    return toEntry(findEntryById(db, existing.id) ?? existing)
  }

  const row: MemoryEntryRow = {
    count: 1,
    created_at_ms: input.now,
    hash,
    id: `mem_${randomUUID().replace(/-/g, "")}`,
    last_seen_at_ms: input.now,
    pinned: input.pinned ? 1 : 0,
    project_id: input.projectId,
    session_count: 1,
    session_id: input.sessionId,
    source: input.source,
    strength: INITIAL_STRENGTH,
    supersedes: input.supersedes ?? null,
    text: input.text,
    tier: input.tier,
  }
  db.prepare(
    `INSERT INTO memory_entries
       (id, project_id, session_id, tier, text, hash, count, strength,
        created_at_ms, last_seen_at_ms, pinned, supersedes, source, session_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.project_id,
    row.session_id,
    row.tier,
    row.text,
    row.hash,
    row.count,
    row.strength,
    row.created_at_ms,
    row.last_seen_at_ms,
    row.pinned,
    row.supersedes,
    row.source,
    row.session_count,
  )
  return toEntry(row)
}

function getPinnedGoal(
  db: SqliteDatabase,
  projectId: string,
): MemoryEntryRow | undefined {
  return db
    .prepare(
      `SELECT * FROM memory_entries
        WHERE project_id = ? AND tier = 'goal' AND pinned = 1
        ORDER BY created_at_ms DESC LIMIT 1`,
    )
    .get(projectId) as MemoryEntryRow | undefined
}

/**
 * Pin a new goal. An existing goal is softly retired: it keeps its text but is
 * unpinned, so the block can still show it as "Vorheriges Ziel".
 */
function setGoal(
  db: SqliteDatabase,
  input: {
    projectId: string
    sessionId: string
    text: string
    source: MemorySource
    now: number
  },
): MemoryEntry {
  const hash = contentHash(input.text)
  const sameText = db
    .prepare(
      `SELECT * FROM memory_entries
        WHERE project_id = ? AND tier = 'goal' AND hash = ? LIMIT 1`,
    )
    .get(input.projectId, hash) as MemoryEntryRow | undefined

  db.prepare(
    "UPDATE memory_entries SET pinned = 0 WHERE project_id = ? AND tier = 'goal'",
  ).run(input.projectId)

  if (sameText) {
    db.prepare(
      `UPDATE memory_entries
         SET pinned = 1,
             strength = MIN(?, strength + ?),
             last_seen_at_ms = ?,
             count = count + 1
       WHERE id = ?`,
    ).run(MAX_STRENGTH, BOOST, input.now, sameText.id)
    return toEntry(findEntryById(db, sameText.id) ?? sameText)
  }

  const previous = getPinnedGoal(db, input.projectId)
  return recordEntry(db, {
    now: input.now,
    pinned: true,
    projectId: input.projectId,
    sessionId: input.sessionId,
    source: input.source,
    supersedes: previous?.id ?? null,
    text: input.text,
    tier: "goal",
  })
}

function decayProject(db: SqliteDatabase, projectId: string): void {
  db.prepare(
    `UPDATE memory_entries SET strength = MAX(0, strength - ?)
      WHERE project_id = ? AND pinned = 0 AND tier = 'step' AND count < ?`,
  ).run(DECAY_PER_TURN.step, projectId, PROCEDURAL_THRESHOLD)
  db.prepare(
    `UPDATE memory_entries SET strength = MAX(0, strength - ?)
      WHERE project_id = ? AND pinned = 0
        AND (tier = 'procedural' OR (tier = 'step' AND count >= ?))`,
  ).run(DECAY_PER_TURN.procedural, projectId, PROCEDURAL_THRESHOLD)
  db.prepare(
    `UPDATE memory_entries SET strength = MAX(0, strength - ?)
      WHERE project_id = ? AND pinned = 0 AND tier = 'semantic'`,
  ).run(DECAY_PER_TURN.semantic, projectId)
  db.prepare(
    `UPDATE memory_entries SET strength = MAX(0, strength - ?)
      WHERE project_id = ? AND pinned = 0 AND tier = 'assignment'`,
  ).run(DECAY_PER_TURN.assignment, projectId)
}

function queryEntries(
  db: SqliteDatabase,
  projectId: string,
  input: { sessionId?: string; tier?: MemoryTier; limit?: number } = {},
): Array<MemoryEntry> {
  const clauses = ["project_id = ?"]
  const values: Array<string | number> = [projectId]
  if (input.sessionId) {
    clauses.push("session_id = ?")
    values.push(input.sessionId)
  }
  if (input.tier) {
    clauses.push("tier = ?")
    values.push(input.tier)
  }
  const limit =
    input.limit && input.limit > 0 ? Math.min(input.limit, 1000) : 500
  const rows = db
    .prepare(
      `SELECT * FROM memory_entries WHERE ${clauses.join(" AND ")}
        ORDER BY pinned DESC, strength DESC, last_seen_at_ms DESC LIMIT ?`,
    )
    .all(...values, limit) as Array<MemoryEntryRow>
  return rows.map(toEntry)
}

export class MemoryStore {
  private readonly dbStore: SqliteDbStore

  constructor(dbPath: string) {
    this.dbStore = new SqliteDbStore({
      getPath: () => dbPath,
      initialize: initializeMemoryDb,
    })
  }

  close(): Promise<void> {
    return this.dbStore.close()
  }

  private db(): Promise<SqliteDatabase> {
    return this.dbStore.getDb()
  }

  async ensureProject(project: ResolvedProject): Promise<void> {
    const db = await this.db()
    const now = Date.now()
    db.prepare(
      `INSERT INTO memory_projects
         (id, name, root, remote, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         root = excluded.root,
         remote = excluded.remote,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(project.id, project.name, project.root, project.remote, now, now)
  }

  async listProjects(): Promise<Array<MemoryProject>> {
    const db = await this.db()
    const rows = db
      .prepare("SELECT * FROM memory_projects ORDER BY updated_at_ms DESC")
      .all() as Array<MemoryProjectRow>
    return rows.map(toProject)
  }

  async getEntries(
    projectId: string,
    input: { sessionId?: string; tier?: MemoryTier; limit?: number } = {},
  ): Promise<Array<MemoryEntry>> {
    return queryEntries(await this.db(), projectId, input)
  }

  async observe(input: MemoryObserveInput): Promise<MemoryEntry | null> {
    const db = await this.db()
    const now = input.now ?? Date.now()
    const text = normalizeText(input.text)
    if (!text) return null
    const { projectId, sessionId } = input
    const source = input.source

    switch (input.kind) {
      case "goal":
        return setGoal(db, {
          now,
          projectId,
          sessionId,
          source: source ?? "user",
          text: compactText(text, GOAL_MAX_CHARS),
        })
      case "semantic":
        return recordEntry(db, {
          now,
          projectId,
          sessionId,
          source: source ?? "user",
          text: compactText(text, STEP_MAX_CHARS),
          tier: "semantic",
        })
      case "subagent":
        return recordEntry(db, {
          now,
          projectId,
          sessionId,
          source: "subagent",
          text: compactText(text, STEP_MAX_CHARS),
          tier: "assignment",
        })
      case "tool":
      case "summary":
        return recordEntry(db, {
          now,
          projectId,
          sessionId,
          source: input.kind === "tool" ? "tool" : "summary",
          text: compactText(text, STEP_MAX_CHARS),
          tier: "step",
        })
      case "user":
      default: {
        // Every new user turn ages the existing memory before recording.
        decayProject(db, projectId)
        const marker = GOAL_MARKER.exec(text)
        let primary: MemoryEntry | null
        if (marker) {
          primary = setGoal(db, {
            now,
            projectId,
            sessionId,
            source: "user",
            text: compactText(marker[1], GOAL_MAX_CHARS),
          })
        } else if (!getPinnedGoal(db, projectId)) {
          // Heuristic: the first user prompt of a fresh project is the goal.
          primary = setGoal(db, {
            now,
            projectId,
            sessionId,
            source: "user",
            text: compactText(text, GOAL_MAX_CHARS),
          })
        } else {
          primary = recordEntry(db, {
            now,
            projectId,
            sessionId,
            source: "user",
            text: compactText(text, STEP_MAX_CHARS),
            tier: "step",
          })
        }
        for (const line of text.split("\n")) {
          const semantic = SEMANTIC_MARKER.exec(line)
          if (semantic) {
            recordEntry(db, {
              now,
              projectId,
              sessionId,
              source: "user",
              text: compactText(semantic[1], STEP_MAX_CHARS),
              tier: "semantic",
            })
          }
        }
        return primary
      }
    }
  }

  async getContext(input: MemoryContextInput): Promise<MemoryBlock> {
    const db = await this.db()
    const entries = queryEntries(db, input.projectId)
    const block = buildMemoryBlock({
      entries,
      options: {
        budget: input.budget,
        maxKnowledge: input.maxKnowledge,
        maxSteps: input.maxSteps,
      },
      projectId: input.projectId,
      sessionId: input.sessionId,
    })
    if (block.usedIds.length > 0) {
      const now = Date.now()
      const boost = db.prepare(
        `UPDATE memory_entries
           SET strength = MIN(?, strength + ?), last_seen_at_ms = ?
         WHERE id = ?`,
      )
      for (const id of block.usedIds) boost.run(MAX_STRENGTH, BOOST, now, id)
    }
    return block
  }

  /** Drop forgotten, non-pinned entries. Returns how many rows were removed. */
  async compact(projectId?: string): Promise<number> {
    const db = await this.db()
    const countRows = () =>
      (
        db.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as {
          count: number
        }
      ).count
    const before = countRows()
    if (projectId) {
      db.prepare(
        `DELETE FROM memory_entries
          WHERE project_id = ? AND pinned = 0 AND strength < ?`,
      ).run(projectId, FORGET_FLOOR)
    } else {
      db.prepare(
        "DELETE FROM memory_entries WHERE pinned = 0 AND strength < ?",
      ).run(FORGET_FLOOR)
    }
    return before - countRows()
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const db = await this.db()
    const existing = db
      .prepare("SELECT id FROM memory_projects WHERE id = ?")
      .get(projectId)
    db.prepare("DELETE FROM memory_entries WHERE project_id = ?").run(projectId)
    db.prepare("DELETE FROM memory_projects WHERE id = ?").run(projectId)
    return Boolean(existing)
  }
}

let store: MemoryStore | undefined

export function getMemoryStore(): MemoryStore {
  store ??= new MemoryStore(getMemoryDbPath())
  return store
}

export async function closeMemoryStore(): Promise<void> {
  const current = store
  store = undefined
  await current?.close()
}

export function resetMemoryStoreForTesting(): void {
  store = undefined
}
