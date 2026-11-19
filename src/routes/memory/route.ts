import { Hono, type Context } from "hono"

import {
  DEFAULT_BUDGET,
  DEFAULT_MAX_KNOWLEDGE,
  DEFAULT_MAX_STEPS,
  getMemoryStore,
  resolveProjectRef,
  type MemoryObserveKind,
  type MemorySource,
  type MemoryTier,
  type ResolvedProject,
} from "~/lib/memory"

const OBSERVE_KINDS = new Set<MemoryObserveKind>([
  "user",
  "tool",
  "summary",
  "subagent",
  "goal",
  "semantic",
])
const SOURCES = new Set<MemorySource>(["user", "tool", "summary", "subagent"])

function badRequest(c: Context, message: string): Response {
  return c.json({ error: { message, type: "invalid_request_error" } }, 400)
}

function parseCount(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function resolveProject(
  ref: string | undefined,
  path?: string,
): ResolvedProject {
  return resolveProjectRef(ref, path)
}

function projectView(project: ResolvedProject) {
  return { id: project.id, name: project.name }
}

export function createMemoryRoutes(): Hono {
  const routes = new Hono()

  routes.get("/context", async (c) => {
    const project = resolveProject(c.req.query("project"), c.req.query("path"))
    const sessionId = stringValue(c.req.query("session_id"))
    const store = getMemoryStore()
    await store.ensureProject(project)
    const block = await store.getContext({
      budget: parseCount(c.req.query("budget"), DEFAULT_BUDGET),
      maxKnowledge: parseCount(
        c.req.query("max_knowledge"),
        DEFAULT_MAX_KNOWLEDGE,
      ),
      maxSteps: parseCount(c.req.query("max_steps"), DEFAULT_MAX_STEPS),
      projectId: project.id,
      sessionId,
    })
    return c.json({
      block: block.text,
      goal: block.goal,
      previous_goal: block.previousGoal,
      project: projectView(project),
      session_id: sessionId,
      truncated: block.truncated,
    })
  })

  routes.post("/observe", async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (typeof body !== "object" || body === null) {
      return badRequest(c, "Expected a JSON object body")
    }
    const payload = body as Record<string, unknown>
    const kind = stringValue(payload.kind) as MemoryObserveKind
    if (!OBSERVE_KINDS.has(kind)) {
      return badRequest(
        c,
        "kind must be one of user, tool, summary, subagent, goal, semantic",
      )
    }
    const text = stringValue(payload.text)
    if (!text) return badRequest(c, "text must be a non-empty string")

    const sourceValue = stringValue(payload.source)
    if (sourceValue && !SOURCES.has(sourceValue as MemorySource)) {
      return badRequest(c, "source must be user, tool, summary, or subagent")
    }

    const project = resolveProject(
      stringValue(payload.project) || undefined,
      stringValue(payload.path) || undefined,
    )
    const sessionId = stringValue(payload.session_id)
    const store = getMemoryStore()
    await store.ensureProject(project)
    const entry = await store.observe({
      kind,
      projectId: project.id,
      sessionId,
      text,
      ...(sourceValue ? { source: sourceValue as MemorySource } : {}),
    })
    const block = await store.getContext({
      budget: parseCount(
        typeof payload.budget === "number" ? String(payload.budget) : undefined,
        DEFAULT_BUDGET,
      ),
      maxKnowledge: DEFAULT_MAX_KNOWLEDGE,
      maxSteps: DEFAULT_MAX_STEPS,
      projectId: project.id,
      sessionId,
    })
    return c.json({
      block: block.text,
      entry,
      goal: block.goal,
      previous_goal: block.previousGoal,
      project: projectView(project),
      session_id: sessionId,
      truncated: block.truncated,
    })
  })

  routes.get("/entries", async (c) => {
    const project = resolveProject(c.req.query("project"), c.req.query("path"))
    const tier = stringValue(c.req.query("tier"))
    const store = getMemoryStore()
    await store.ensureProject(project)
    const entries = await store.getEntries(project.id, {
      ...(tier ? { tier: tier as MemoryTier } : {}),
      ...(stringValue(c.req.query("session_id")) ?
        { sessionId: stringValue(c.req.query("session_id")) }
      : {}),
      limit: parseCount(c.req.query("limit"), 200),
    })
    return c.json({ entries, project: projectView(project) })
  })

  routes.get("/projects", async (c) => {
    return c.json({ projects: await getMemoryStore().listProjects() })
  })

  routes.post("/compact", async (c) => {
    const ref = stringValue(c.req.query("project"))
    const removed =
      ref ?
        await getMemoryStore().compact(resolveProject(ref).id)
      : await getMemoryStore().compact()
    return c.json({ removed })
  })

  return routes
}

export function createMemoryAdminRoutes(): Hono {
  const routes = new Hono()

  routes.delete("/projects/:id", async (c) => {
    const id = c.req.param("id")
    const deleted = await getMemoryStore().deleteProject(id)
    if (!deleted) return c.json({ error: { message: "Unknown project" } }, 404)
    return c.json({ deleted: true, id })
  })

  return routes
}

export const memoryRoutes = createMemoryRoutes()
export const memoryAdminRoutes = createMemoryAdminRoutes()
