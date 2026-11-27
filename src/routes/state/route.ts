import { Hono, type Context } from "hono"

import { pgAvailable } from "~/lib/pg/client"
import { getStateConfig } from "~/lib/state/config"
import { PgStateStore } from "~/lib/state/store"
import { buildBootstrapPackage } from "~/lib/state/bootstrap"
import { embedTexts } from "~/lib/state/embedding"
import { isValidRepoId, resolveRepo } from "~/lib/state/repo"
import { isBlueprintTrigger, extractBlueprint } from "~/lib/state/blueprint"
import { cleanString, clampLimit, cleanList } from "~/lib/state/validate"

import type { StateRepository } from "~/lib/state/repository"
import type { StateEventKind } from "~/lib/state/types"

const EVENT_KINDS = new Set([
  "step",
  "tool",
  "error",
  "decision",
  "summary",
  "subagent",
  "goal",
  "blueprint",
])

function badRequest(c: Context, message: string): Response {
  return c.json({ error: { message, type: "invalid_request_error" } }, 400)
}

function unavailable(c: Context): Response {
  return c.json(
    { error: { message: "state store unavailable", type: "unavailable" } },
    503,
  )
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export interface StateRouteOptions {
  repository?: StateRepository
  getRepository?: () => StateRepository | null
}

function defaultRepository(): StateRepository | null {
  if (!getStateConfig().enabled) {
    return null
  }
  if (!pgAvailable()) {
    return null
  }
  return new PgStateStore()
}

function repositoryFrom(options: StateRouteOptions): StateRepository | null {
  if (options.repository) return options.repository
  // A getter that returns null means the store is unavailable. Do not fall
  // through to the process database.
  if (options.getRepository) return options.getRepository()
  return defaultRepository()
}

export function createStateRoutes(options: StateRouteOptions = {}): Hono {
  const routes = new Hono()
  const getRepo = (): StateRepository | null => repositoryFrom(options)

  const getState = async (c: Context) => {
    const repoId = c.req.param("repo_id") ?? ""
    if (!isValidRepoId(repoId)) {
      return badRequest(c, "repo_id must be a proj_<hash> id")
    }
    const repo = getRepo()
    if (!repo) {
      return c.json({ state: null, repo_id: repoId })
    }
    const state = await repo.getState(repoId).catch(() => null)
    return c.json({ state, repo_id: repoId })
  }

  const putState = async (c: Context) => {
    const repoId = c.req.param("repo_id") ?? ""
    if (!isValidRepoId(repoId)) {
      return badRequest(c, "repo_id must be a proj_<hash> id")
    }
    const repo = getRepo()
    if (!repo) {
      return unavailable(c)
    }
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== "object" || body === null) {
      return badRequest(c, "Expected a JSON object body")
    }
    const payload = body as Record<string, unknown>
    const input = {
      git_remote_url: cleanString(payload.git_remote_url, 2000) || undefined,
      branch: cleanString(payload.branch, 500) || undefined,
      commit_sha: cleanString(payload.commit_sha, 500) || undefined,
      goal: cleanString(payload.goal, 2000) || undefined,
      last_model: cleanString(payload.last_model, 500) || undefined,
      session_id: cleanString(payload.session_id, 500) || undefined,
      completed_steps: cleanList(payload.completed_steps),
      pending_steps: cleanList(payload.pending_steps),
      failed_attempts: cleanList(payload.failed_attempts),
      active_files: cleanList(payload.active_files),
      constraints: cleanList(payload.constraints),
      tech_stack: cleanList(payload.tech_stack),
    } satisfies Parameters<StateRepository["putState"]>[1]
    // Only send list fields the client actually provided.
    const provided: Record<string, unknown> = {
      git_remote_url: input.git_remote_url,
      branch: input.branch,
      commit_sha: input.commit_sha,
      goal: input.goal,
      last_model: input.last_model,
      session_id: input.session_id,
    }
    for (const key of [
      "completed_steps",
      "pending_steps",
      "failed_attempts",
      "active_files",
      "constraints",
      "tech_stack",
    ] as const) {
      if (key in payload) {
        provided[key] = input[key]
      }
    }
    const state = await repo.putState(repoId, provided)
    return c.json({ state })
  }

  const postEvent = async (c: Context) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== "object" || body === null) {
      return badRequest(c, "Expected a JSON object body")
    }
    const payload = body as Record<string, unknown>
    const rawRepo = stringValue(payload.repo_id)
    if (!rawRepo) {
      return badRequest(c, "repo_id is required")
    }
    const repoId =
      isValidRepoId(rawRepo) ? rawRepo : resolveRepo(rawRepo).repo_id
    const kind = stringValue(payload.kind)
    if (!EVENT_KINDS.has(kind)) {
      return badRequest(
        c,
        "kind must be step|tool|error|decision|summary|subagent|goal|blueprint",
      )
    }
    const summary = cleanString(payload.summary, 4000)
    if (!summary) {
      return badRequest(c, "summary must be a non-empty string")
    }
    const repo = getRepo()
    if (!repo) {
      return unavailable(c)
    }
    const detail =
      typeof payload.detail === "object" && payload.detail !== null ?
        (payload.detail as Record<string, unknown>)
      : {}
    const event = await repo.appendEvent({
      repo_id: repoId,
      session_id: cleanString(payload.session_id, 500),
      kind: kind as StateEventKind,
      summary,
      detail,
      tech_stack: cleanList(payload.tech_stack),
      resolved: payload.resolved === true,
    })
    // Deterministic blueprint extraction (synchronous).
    let blueprint = null
    if (isBlueprintTrigger(event)) {
      const extracted = extractBlueprint(event)
      const [embedding] =
        (await embedTexts([
          `${extracted.title}\n${extracted.problem}\n${extracted.solution}`,
        ])) ?? []
      blueprint = await repo
        .addBlueprint({
          ...extracted,
          source_repo: event.repo_id,
          source_event: event.id,
          origin: "deterministic",
          embedding: embedding ?? null,
        })
        .catch(() => null)
    }
    // Optional async model extraction (fire-and-forget, never blocks).
    const config = getStateConfig()
    if (
      config.extractorModel
      && config.allowMeteredExtraction
      && event.resolved
      && !isBlueprintTrigger(event)
    ) {
      void (async () => {
        try {
          const extracted = extractBlueprint(event)
          const [embedding] =
            (await embedTexts([
              `${extracted.title}\n${extracted.problem}\n${extracted.solution}`,
            ])) ?? []
          await repo.addBlueprint({
            ...extracted,
            source_repo: event.repo_id,
            source_event: event.id,
            origin: "model",
            embedding: embedding ?? null,
          })
        } catch {
          // Fire-and-forget: ignore errors.
        }
      })()
    }
    return c.json({ event, blueprint })
  }

  const listEvents = async (c: Context) => {
    const raw = c.req.param("repo_id") ?? ""
    const repoId = isValidRepoId(raw) ? raw : resolveRepo(raw).repo_id
    const repo = getRepo()
    if (!repo) {
      return c.json({ events: [] })
    }
    const events = await repo.listEvents(
      repoId,
      stringValue(c.req.query("kind")) || undefined,
      clampLimit(c.req.query("limit"), 50),
    )
    return c.json({ events })
  }

  const getBootstrap = async (c: Context) => {
    const raw = c.req.param("repo_id") ?? ""
    const repoId = isValidRepoId(raw) ? raw : resolveRepo(raw).repo_id
    const include = c.req.query("include_blueprints") !== "false"
    const repo = getRepo()
    const config = getStateConfig()
    const state = repo ? await repo.getState(repoId).catch(() => null) : null
    const blueprints =
      repo && include ?
        await repo
          .searchBlueprints({
            tech_stack: state?.tech_stack ?? [],
            query: state?.goal ?? "",
            limit: config.blueprintSearchLimit,
          })
          .catch(() => [])
      : []
    const pkg = buildBootstrapPackage({
      repo_id: repoId,
      state,
      blueprints,
    })
    return c.json({ bootstrap: pkg, markdown: pkg.markdown })
  }

  const searchBlueprints = async (c: Context) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== "object" || body === null) {
      return badRequest(c, "Expected a JSON object body")
    }
    const payload = body as Record<string, unknown>
    const repo = getRepo()
    if (!repo) {
      return c.json({ blueprints: [] })
    }
    const query = cleanString(payload.query, 4000)
    const tech = cleanList(payload.tech_stack)
    const limit = clampLimit(
      payload.limit,
      getStateConfig().blueprintSearchLimit,
    )
    let embedding: number[] | null = null
    if (query) {
      const [vector] = (await embedTexts([query])) ?? []
      embedding = vector ?? null
    }
    const blueprints = await repo.searchBlueprints({
      tech_stack: tech,
      query,
      limit,
      embedding,
    })
    for (const blueprint of blueprints) {
      if (blueprint.id) {
        void repo.bumpBlueprintUse(blueprint.id).catch(() => {})
      }
    }
    return c.json({ blueprints })
  }

  const listBlueprints = async (c: Context) => {
    const repo = getRepo()
    if (!repo) {
      return c.json({ blueprints: [] })
    }
    const blueprints = await repo.listBlueprints(
      clampLimit(c.req.query("limit"), 20),
    )
    return c.json({ blueprints })
  }

  for (const prefix of ["/v1", "/api/v1"]) {
    routes.get(`${prefix}/state/:repo_id`, getState)
    routes.put(`${prefix}/state/:repo_id`, putState)
    routes.post(`${prefix}/events`, postEvent)
    routes.get(`${prefix}/events/:repo_id`, listEvents)
    routes.get(`${prefix}/bootstrap/:repo_id`, getBootstrap)
    routes.post(`${prefix}/blueprints/search`, searchBlueprints)
    routes.get(`${prefix}/blueprints`, listBlueprints)
  }
  return routes
}

export function createStateAdminRoutes(options: StateRouteOptions = {}): Hono {
  const routes = new Hono()
  const getRepo = (): StateRepository | null => repositoryFrom(options)

  routes.delete("/state/:repo_id", async (c) => {
    const repoId = c.req.param("repo_id") ?? ""
    const repo = getRepo()
    if (!repo) {
      return unavailable(c)
    }
    await repo.deleteRepo(repoId)
    return c.json({ deleted: true, repo_id: repoId })
  })

  routes.get("/state/repos", async (c) => {
    const repo = getRepo()
    if (!repo) {
      return c.json({ repos: [] })
    }
    const repos = await repo.listRepos()
    const states = await Promise.all(
      repos.map((id) => repo.getState(id).catch(() => null)),
    )
    return c.json({ repos, states })
  })

  return routes
}
