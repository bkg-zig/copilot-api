import { getPgClient } from "~/lib/pg/client"

import { getStateConfig } from "./config"
import type { StateRepository } from "./repository"
import { blueprintText, embedTexts, toVectorLiteral } from "./embedding"
import { cleanString } from "./validate"

import type {
  Blueprint,
  BlueprintSearchInput,
  StateEvent,
  StateEventInput,
  WorkingState,
  WorkingStateInput,
} from "./types"

const SCHEMA_STATEMENTS = [
  // public on a plain image, extensions on the pgrust mango image.
  // The client search_path includes both, so `vector(1536)` resolves.
  "CREATE EXTENSION IF NOT EXISTS vector",
  `CREATE TABLE IF NOT EXISTS repo_working_state (
     repo_id text PRIMARY KEY, git_remote_url text NOT NULL DEFAULT '',
     branch text NOT NULL DEFAULT '', commit_sha text NOT NULL DEFAULT '',
     goal text NOT NULL DEFAULT '', completed_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
     pending_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
     failed_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
     active_files jsonb NOT NULL DEFAULT '[]'::jsonb,
     constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
     tech_stack jsonb NOT NULL DEFAULT '[]'::jsonb,
     last_model text NOT NULL DEFAULT '', session_id text NOT NULL DEFAULT '',
     revision bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS repo_event_log (
     id bigserial PRIMARY KEY, repo_id text NOT NULL, session_id text NOT NULL DEFAULT '',
     kind text NOT NULL, summary text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
     tech_stack jsonb NOT NULL DEFAULT '[]'::jsonb, resolved boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now())`,
  "CREATE INDEX IF NOT EXISTS idx_event_log_repo ON repo_event_log (repo_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS cross_repo_blueprints (
     id bigserial PRIMARY KEY, title text NOT NULL, problem text NOT NULL, solution text NOT NULL,
     tech_stack jsonb NOT NULL DEFAULT '[]'::jsonb, tokens jsonb NOT NULL DEFAULT '[]'::jsonb,
     source_repo text NOT NULL DEFAULT '', source_event bigint,
     origin text NOT NULL DEFAULT 'deterministic', embedding vector(1536),
     search_tsv tsvector GENERATED ALWAYS AS (
       to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(problem,'') || ' ' || coalesce(solution,''))
     ) STORED,
     use_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now())`,
  "CREATE INDEX IF NOT EXISTS idx_blueprints_tsv ON cross_repo_blueprints USING GIN (search_tsv)",
  // No HNSW index: pgrust refuses writes and scans on tables that carry one.
  // Vector search runs as an exact scan. Drop the index older schemas created.
  "DROP INDEX IF EXISTS idx_blueprints_embedding",
  "CREATE INDEX IF NOT EXISTS idx_blueprints_tech ON cross_repo_blueprints USING GIN (tech_stack)",
]

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** postgres.js returns timestamptz as Date; SQL text and the unit mock return strings. */
function iso(value: unknown): string | undefined {
  const date =
    value instanceof Date ? value
    : typeof value === "string" && value.trim() ? new Date(value)
    : undefined
  if (!date || Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function jsonList(value: unknown): unknown {
  const parsed = parseJson(value)
  if (Array.isArray(parsed)) {
    return parsed
  }
  return []
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value)
  if (typeof parsed === "object" && parsed !== null) {
    return parsed as Record<string, unknown>
  }
  return {}
}

function rowToState(row: Record<string, unknown>): WorkingState {
  return {
    repo_id: String(row.repo_id),
    git_remote_url: str(row.git_remote_url),
    branch: str(row.branch),
    commit_sha: str(row.commit_sha),
    goal: str(row.goal),
    completed_steps: (jsonList(row.completed_steps) as unknown[]).map(String),
    pending_steps: (jsonList(row.pending_steps) as unknown[]).map(String),
    failed_attempts: (jsonList(row.failed_attempts) as unknown[]).map(String),
    active_files: (jsonList(row.active_files) as unknown[]).map(String),
    constraints: (jsonList(row.constraints) as unknown[]).map(String),
    tech_stack: (jsonList(row.tech_stack) as unknown[]).map(String),
    last_model: str(row.last_model),
    session_id: str(row.session_id),
    revision: num(row.revision),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

function rowToEvent(row: Record<string, unknown>): StateEvent {
  return {
    id: num(row.id),
    repo_id: String(row.repo_id),
    session_id: str(row.session_id),
    kind: String(row.kind) as StateEvent["kind"],
    summary: str(row.summary),
    detail: jsonObject(row.detail),
    tech_stack: (jsonList(row.tech_stack) as unknown[]).map(String),
    resolved: Boolean(row.resolved),
    created_at: iso(row.created_at),
  }
}

function rowToBlueprint(row: Record<string, unknown>): Blueprint {
  return {
    id: num(row.id),
    title: str(row.title),
    problem: str(row.problem),
    solution: str(row.solution),
    tech_stack: (jsonList(row.tech_stack) as unknown[]).map(String),
    tokens: (jsonList(row.tokens) as unknown[]).map(String),
    source_repo: str(row.source_repo),
    source_event:
      row.source_event == null ? undefined : Number(row.source_event),
    origin: row.origin === "model" ? "model" : "deterministic",
    use_count: num(row.use_count),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  }
}

/** Postgres-backed StateRepository (lazy, error-tolerant). */
export class PgStateStore implements StateRepository {
  private migrated = false

  async ensureSchema(): Promise<boolean> {
    if (this.migrated) {
      return true
    }
    const sql = getPgClient()
    if (!sql) {
      return false
    }
    if (!getStateConfig().autoMigrate) {
      this.migrated = true
      return true
    }
    for (const statement of SCHEMA_STATEMENTS) {
      try {
        await sql.unsafe(statement)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Shared Postgres already has the extension, created by a superuser.
        // A database owner may not be allowed to run CREATE EXTENSION again.
        if (
          statement.startsWith("CREATE EXTENSION")
          && /permission denied|already exists/iu.test(message)
        ) {
          continue
        }
        throw error
      }
    }
    this.migrated = true
    return true
  }

  async getState(repoId: string): Promise<WorkingState | null> {
    const sql = getPgClient()
    if (!sql) {
      return null
    }
    await this.ensureSchema()
    const rows =
      await sql`SELECT * FROM repo_working_state WHERE repo_id = ${repoId}`
    return rows.length > 0 ?
        rowToState(rows[0] as Record<string, unknown>)
      : null
  }

  async putState(
    repoId: string,
    input: WorkingStateInput,
  ): Promise<WorkingState> {
    const sql = getPgClient()
    if (!sql) {
      throw new Error("Postgres unavailable")
    }
    await this.ensureSchema()
    const previous = await this.getState(repoId)
    const next: WorkingState = {
      repo_id: repoId,
      git_remote_url: input.git_remote_url ?? previous?.git_remote_url ?? "",
      branch: cleanString(input.branch, 500) || previous?.branch || "",
      commit_sha:
        cleanString(input.commit_sha, 500) || previous?.commit_sha || "",
      goal: cleanString(input.goal, 2000) || previous?.goal || "",
      completed_steps: input.completed_steps ?? previous?.completed_steps ?? [],
      pending_steps: input.pending_steps ?? previous?.pending_steps ?? [],
      failed_attempts: input.failed_attempts ?? previous?.failed_attempts ?? [],
      active_files: input.active_files ?? previous?.active_files ?? [],
      constraints: input.constraints ?? previous?.constraints ?? [],
      tech_stack: input.tech_stack ?? previous?.tech_stack ?? [],
      last_model:
        cleanString(input.last_model, 500) || previous?.last_model || "",
      session_id:
        cleanString(input.session_id, 500) || previous?.session_id || "",
      revision: (previous?.revision ?? 0) + 1,
    }
    const rows = await sql`
      INSERT INTO repo_working_state
        (repo_id, git_remote_url, branch, commit_sha, goal, completed_steps, pending_steps,
         failed_attempts, active_files, constraints, tech_stack, last_model, session_id, revision)
      VALUES
        (${next.repo_id}, ${next.git_remote_url}, ${next.branch}, ${next.commit_sha}, ${next.goal},
         ${JSON.stringify(next.completed_steps)}::text::jsonb, ${JSON.stringify(next.pending_steps)}::text::jsonb,
         ${JSON.stringify(next.failed_attempts)}::text::jsonb, ${JSON.stringify(next.active_files)}::text::jsonb,
         ${JSON.stringify(next.constraints)}::text::jsonb, ${JSON.stringify(next.tech_stack)}::text::jsonb,
         ${next.last_model}, ${next.session_id}, ${next.revision})
      ON CONFLICT (repo_id) DO UPDATE SET
        git_remote_url = EXCLUDED.git_remote_url, branch = EXCLUDED.branch,
        commit_sha = EXCLUDED.commit_sha, goal = EXCLUDED.goal,
        completed_steps = EXCLUDED.completed_steps, pending_steps = EXCLUDED.pending_steps,
        failed_attempts = EXCLUDED.failed_attempts, active_files = EXCLUDED.active_files,
        constraints = EXCLUDED.constraints, tech_stack = EXCLUDED.tech_stack,
        last_model = EXCLUDED.last_model, session_id = EXCLUDED.session_id,
        revision = EXCLUDED.revision, updated_at = now()
      RETURNING *`
    return rowToState(rows[0] as Record<string, unknown>)
  }

  async appendEvent(input: StateEventInput): Promise<StateEvent> {
    const sql = getPgClient()
    if (!sql) {
      throw new Error("Postgres unavailable")
    }
    await this.ensureSchema()
    const rows = await sql`
      INSERT INTO repo_event_log (repo_id, session_id, kind, summary, detail, tech_stack, resolved)
      VALUES (${input.repo_id}, ${input.session_id ?? ""}, ${input.kind}, ${input.summary},
              ${JSON.stringify(input.detail ?? {})}::text::jsonb, ${JSON.stringify(input.tech_stack ?? [])}::text::jsonb,
              ${input.resolved ?? false})
      RETURNING *`
    return rowToEvent(rows[0] as Record<string, unknown>)
  }

  async listEvents(
    repoId: string,
    kind?: string,
    limit = 50,
  ): Promise<StateEvent[]> {
    const sql = getPgClient()
    if (!sql) {
      return []
    }
    await this.ensureSchema()
    const rows =
      kind ?
        await sql`SELECT * FROM repo_event_log WHERE repo_id = ${repoId} AND kind = ${kind}
                  ORDER BY created_at DESC LIMIT ${limit}`
      : await sql`SELECT * FROM repo_event_log WHERE repo_id = ${repoId}
                  ORDER BY created_at DESC LIMIT ${limit}`
    return rows.map((row) => rowToEvent(row as Record<string, unknown>))
  }

  async addBlueprint(input: Blueprint): Promise<Blueprint> {
    const sql = getPgClient()
    if (!sql) {
      throw new Error("Postgres unavailable")
    }
    await this.ensureSchema()
    const vectors = await embedTexts([blueprintText(input)])
    const embedding = vectors?.[0] ?? input.embedding ?? null
    const embeddingLiteral = embedding ? toVectorLiteral(embedding) : null
    const rows = await sql`
      INSERT INTO cross_repo_blueprints
        (title, problem, solution, tech_stack, tokens, source_repo, source_event, origin, embedding)
      VALUES
        (${input.title}, ${input.problem}, ${input.solution},
         ${JSON.stringify(input.tech_stack)}::text::jsonb, ${JSON.stringify(input.tokens)}::text::jsonb,
         ${input.source_repo}, ${input.source_event ?? null}, ${input.origin},
         ${embeddingLiteral}::vector(1536))
      RETURNING *`
    return rowToBlueprint(rows[0] as Record<string, unknown>)
  }

  async searchBlueprints(input: BlueprintSearchInput): Promise<Blueprint[]> {
    const sql = getPgClient()
    if (!sql) {
      return []
    }
    await this.ensureSchema()
    const limit = input.limit ?? 5
    if (input.embedding && input.embedding.length > 0) {
      const literal = toVectorLiteral(input.embedding)
      const rows = await sql`
        SELECT *, (1 - (embedding <=> ${literal}::vector(1536))) AS similarity
        FROM cross_repo_blueprints
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> ${literal}::vector(1536)
        LIMIT ${limit}`
      return rows.map((row) => rowToBlueprint(row as Record<string, unknown>))
    }
    const query = (input.query ?? "").trim()
    const stack = (input.tech_stack ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
    const rows =
      query ?
        await sql`
        SELECT *, ts_rank(search_tsv, plainto_tsquery('simple', ${query})) AS rank
        FROM cross_repo_blueprints
        WHERE search_tsv @@ plainto_tsquery('simple', ${query})
           OR tech_stack ?| ARRAY(
             SELECT jsonb_array_elements_text(${JSON.stringify(stack)}::text::jsonb))
        ORDER BY rank DESC, use_count DESC
        LIMIT ${limit}`
      : await sql`
        SELECT * FROM cross_repo_blueprints
        WHERE ${stack.length === 0} OR tech_stack ?| ARRAY(
          SELECT jsonb_array_elements_text(${JSON.stringify(stack)}::text::jsonb))
        ORDER BY use_count DESC, updated_at DESC
        LIMIT ${limit}`
    return rows.map((row) => rowToBlueprint(row as Record<string, unknown>))
  }

  async listBlueprints(limit = 20): Promise<Blueprint[]> {
    const sql = getPgClient()
    if (!sql) {
      return []
    }
    await this.ensureSchema()
    const rows =
      await sql`SELECT * FROM cross_repo_blueprints ORDER BY updated_at DESC LIMIT ${limit}`
    return rows.map((row) => rowToBlueprint(row as Record<string, unknown>))
  }

  async bumpBlueprintUse(id: number): Promise<void> {
    const sql = getPgClient()
    if (!sql) {
      return
    }
    await sql`UPDATE cross_repo_blueprints SET use_count = use_count + 1, updated_at = now() WHERE id = ${id}`
  }

  async deleteRepo(repoId: string): Promise<void> {
    const sql = getPgClient()
    if (!sql) {
      return
    }
    await sql`DELETE FROM repo_event_log WHERE repo_id = ${repoId}`
    await sql`DELETE FROM repo_working_state WHERE repo_id = ${repoId}`
  }

  async listRepos(): Promise<string[]> {
    const sql = getPgClient()
    if (!sql) {
      return []
    }
    const rows =
      await sql`SELECT repo_id FROM repo_working_state ORDER BY repo_id`
    return rows.map((row) => String((row as Record<string, unknown>).repo_id))
  }
}
