export interface WorkingState {
  repo_id: string
  git_remote_url: string
  branch: string
  commit_sha: string
  goal: string
  completed_steps: string[]
  pending_steps: string[]
  failed_attempts: string[]
  active_files: string[]
  constraints: string[]
  tech_stack: string[]
  last_model: string
  session_id: string
  revision: number
  created_at?: string
  updated_at?: string
}

export type StateEventKind =
  | "step"
  | "tool"
  | "error"
  | "decision"
  | "summary"
  | "subagent"
  | "goal"
  | "blueprint"

export interface StateEvent {
  id?: number
  repo_id: string
  session_id: string
  kind: StateEventKind
  summary: string
  detail: Record<string, unknown>
  tech_stack: string[]
  resolved: boolean
  created_at?: string
}

export interface Blueprint {
  id?: number
  title: string
  problem: string
  solution: string
  tech_stack: string[]
  tokens: string[]
  source_repo: string
  source_event?: number
  origin: "deterministic" | "model"
  embedding?: number[] | null
  use_count?: number
  created_at?: string
  updated_at?: string
}

export interface BootstrapPackage {
  repo_id: string
  constraints: string[]
  state: WorkingState | null
  blueprints: Blueprint[]
  protocol_snippet: string
  markdown: string
}

export type WorkingStateInput = Partial<Omit<WorkingState, "repo_id">> & {
  git_remote_url?: string
}

export interface StateEventInput {
  repo_id: string
  session_id?: string
  kind: string
  summary: string
  detail?: Record<string, unknown>
  tech_stack?: string[]
  resolved?: boolean
}

export interface BlueprintSearchInput {
  tech_stack?: string[]
  query?: string
  limit?: number
  embedding?: number[] | null
}
