import type {
  Blueprint,
  BlueprintSearchInput,
  StateEvent,
  StateEventInput,
  WorkingState,
  WorkingStateInput,
} from "./types"

/**
 * Data-access seam for the state owner. Production uses PgStateStore,
 * tests inject an in-memory double (no SQLite, no DB).
 */
export interface StateRepository {
  getState(repoId: string): Promise<WorkingState | null>
  putState(repoId: string, input: WorkingStateInput): Promise<WorkingState>
  appendEvent(input: StateEventInput): Promise<StateEvent>
  listEvents(
    repoId: string,
    kind?: string,
    limit?: number,
  ): Promise<StateEvent[]>
  addBlueprint(input: Blueprint): Promise<Blueprint>
  searchBlueprints(input: BlueprintSearchInput): Promise<Blueprint[]>
  listBlueprints(limit?: number): Promise<Blueprint[]>
  bumpBlueprintUse(id: number): Promise<void>
  deleteRepo(repoId: string): Promise<void>
  listRepos(): Promise<string[]>
}

/** In-memory repository used by tests (and as a degraded fallback). */
export class MemoryStateRepository implements StateRepository {
  private states = new Map<string, WorkingState>()
  private events: StateEvent[] = []
  private blueprints: Blueprint[] = []
  private nextEventId = 1
  private nextBlueprintId = 1

  getState(repoId: string): Promise<WorkingState | null> {
    const found = this.states.get(repoId)
    return Promise.resolve(found ? { ...found } : null)
  }

  async putState(
    repoId: string,
    input: WorkingStateInput,
  ): Promise<WorkingState> {
    await Promise.resolve()
    const previous = this.states.get(repoId)
    const next: WorkingState = {
      repo_id: repoId,
      git_remote_url: input.git_remote_url ?? previous?.git_remote_url ?? "",
      branch: input.branch ?? previous?.branch ?? "",
      commit_sha: input.commit_sha ?? previous?.commit_sha ?? "",
      goal: input.goal ?? previous?.goal ?? "",
      completed_steps: input.completed_steps ?? previous?.completed_steps ?? [],
      pending_steps: input.pending_steps ?? previous?.pending_steps ?? [],
      failed_attempts: input.failed_attempts ?? previous?.failed_attempts ?? [],
      active_files: input.active_files ?? previous?.active_files ?? [],
      constraints: input.constraints ?? previous?.constraints ?? [],
      tech_stack: input.tech_stack ?? previous?.tech_stack ?? [],
      last_model: input.last_model ?? previous?.last_model ?? "",
      session_id: input.session_id ?? previous?.session_id ?? "",
      revision: (previous?.revision ?? 0) + 1,
      created_at: previous?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    this.states.set(repoId, next)
    return { ...next }
  }

  async appendEvent(input: StateEventInput): Promise<StateEvent> {
    await Promise.resolve()
    const event: StateEvent = {
      id: this.nextEventId++,
      repo_id: input.repo_id,
      session_id: input.session_id ?? "",
      kind: input.kind as StateEvent["kind"],
      summary: input.summary,
      detail: input.detail ?? {},
      tech_stack: input.tech_stack ?? [],
      resolved: input.resolved ?? false,
      created_at: new Date().toISOString(),
    }
    this.events.push(event)
    return { ...event }
  }

  async listEvents(
    repoId: string,
    kind?: string,
    limit = 50,
  ): Promise<StateEvent[]> {
    await Promise.resolve()
    return this.events
      .filter(
        (event) => event.repo_id === repoId && (!kind || event.kind === kind),
      )
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event }))
  }

  async addBlueprint(input: Blueprint): Promise<Blueprint> {
    await Promise.resolve()
    const blueprint: Blueprint = {
      ...input,
      id: this.nextBlueprintId++,
      use_count: input.use_count ?? 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    this.blueprints.unshift(blueprint)
    return { ...blueprint }
  }

  async searchBlueprints(input: BlueprintSearchInput): Promise<Blueprint[]> {
    await Promise.resolve()
    const limit = input.limit ?? 5
    const stack = (input.tech_stack ?? []).map((item) => item.toLowerCase())
    const queryTokens = (input.query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
    return this.blueprints
      .filter((blueprint) => {
        if (stack.length === 0) {
          return true
        }
        const own = blueprint.tech_stack.map((item) => item.toLowerCase())
        return stack.some((item) => own.includes(item))
      })
      .map((blueprint) => {
        const text =
          `${blueprint.title} ${blueprint.problem} ${blueprint.solution}`.toLowerCase()
        const score = queryTokens.filter((token) => text.includes(token)).length
        return { blueprint, score }
      })
      .sort(
        (a, b) =>
          b.score - a.score
          || (b.blueprint.use_count ?? 0) - (a.blueprint.use_count ?? 0),
      )
      .slice(0, limit)
      .map((entry) => ({ ...entry.blueprint }))
  }

  async listBlueprints(limit = 20): Promise<Blueprint[]> {
    await Promise.resolve()
    return this.blueprints
      .slice(0, limit)
      .map((blueprint) => ({ ...blueprint }))
  }

  async bumpBlueprintUse(id: number): Promise<void> {
    await Promise.resolve()
    const found = this.blueprints.find((blueprint) => blueprint.id === id)
    if (found) {
      found.use_count = (found.use_count ?? 0) + 1
      found.updated_at = new Date().toISOString()
    }
  }

  async deleteRepo(repoId: string): Promise<void> {
    await Promise.resolve()
    this.states.delete(repoId)
    this.events = this.events.filter((event) => event.repo_id !== repoId)
  }

  async listRepos(): Promise<string[]> {
    await Promise.resolve()
    return [...this.states.keys()]
  }
}
