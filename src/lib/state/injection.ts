import type { Context, Next } from "hono"

import { getStateConfig } from "./config"
import { PROTOCOL_SNIPPET } from "./protocol"
import { buildBootstrapPackage } from "./bootstrap"
import { isValidRepoId, resolveRepo } from "./repo"
import type { StateRepository } from "./repository"

/** Paths the injection middleware applies to. */
const INJECT_PATHS = new Set([
  "/chat/completions",
  "/v1/chat/completions",
  "/v1/messages",
  "/responses",
  "/v1/responses",
])

export function shouldInject(path: string): boolean {
  return INJECT_PATHS.has(path)
}

function prependOpenAI(body: Record<string, unknown>, snippet: string): void {
  const messages: unknown = body.messages
  if (Array.isArray(messages)) {
    const first: unknown = messages[0]
    const isSystem =
      first
      && typeof first === "object"
      && (first as Record<string, unknown>).role === "system"
    if (isSystem) {
      const system = first as Record<string, unknown>
      const content = system.content
      if (typeof content === "string") {
        system.content = `${snippet}\n\n${content}`
      } else if (Array.isArray(content)) {
        content.unshift({ type: "text", text: snippet })
      } else {
        system.content = snippet
      }
      return
    }
    messages.unshift({ role: "system", content: snippet })
    return
  }
  if (typeof body.system === "string") {
    body.system = `${snippet}\n\n${body.system}`
  } else if (Array.isArray(body.system)) {
    body.system.unshift({ type: "text", text: snippet })
  } else if (body.system === undefined) {
    body.system = snippet
  }
}

function prependAnthropic(
  body: Record<string, unknown>,
  snippet: string,
): void {
  if (typeof body.system === "string") {
    body.system = `${snippet}\n\n${body.system}`
  } else if (Array.isArray(body.system)) {
    body.system.unshift({ type: "text", text: snippet })
  } else if (body.system === undefined) {
    body.system = snippet
  }
}

/** Responses requests carry system text in `instructions`, never `system`. */
export function injectInstructions(
  body: Record<string, unknown>,
  snippet: string,
): void {
  if (typeof body.instructions === "string") {
    body.instructions = `${snippet}\n\n${body.instructions}`
  } else if (body.instructions === undefined || body.instructions === null) {
    body.instructions = snippet
  }
}

export function injectSnippet(
  body: Record<string, unknown>,
  snippet: string,
  isAnthropic: boolean,
): void {
  if (isAnthropic) {
    prependAnthropic(body, snippet)
  } else {
    prependOpenAI(body, snippet)
  }
}

/**
 * State-injection middleware: with `X-Repo-Id` it injects the bootstrap
 * summary into the system message. Best-effort; errors never block.
 */
export function createStateInjectionMiddleware(
  getRepository: () => StateRepository | null,
) {
  return async (c: Context, next: Next) => {
    try {
      const path = c.req.path
      if (!shouldInject(path)) {
        await next()
        return
      }
      const config = getStateConfig()
      if (!config.injection.enabled) {
        await next()
        return
      }
      const header = c.req.header("X-Repo-Id")?.trim() ?? ""
      if (!header) {
        await next()
        return
      }
      const repo = resolveRepo(header)
      const repoId = repo.repo_id
      if (!isValidRepoId(repoId)) {
        await next()
        return
      }
      let body: Record<string, unknown> | null = null
      try {
        body = await c.req.json()
      } catch {
        body = null
      }
      if (!body || typeof body !== "object") {
        await next()
        return
      }
      const repository = getRepository()
      if (!repository) {
        await next()
        return
      }
      const state = await repository.getState(repoId).catch(() => null)
      const blueprints =
        config.injection.includeBlueprint ?
          await repository
            .searchBlueprints({
              tech_stack: state?.tech_stack ?? [],
              query: state?.goal ?? "",
              limit: config.blueprintSearchLimit,
            })
            .catch(() => [])
        : []
      const pkg = buildBootstrapPackage({ repo_id: repoId, state, blueprints })
      const snippet = `[repo ${repoId}]\n${pkg.markdown}\n${PROTOCOL_SNIPPET}`
      // Hono caches c.req.json(); handlers read the same mutated object.
      if (path.endsWith("/responses")) {
        injectInstructions(body, snippet)
      } else {
        injectSnippet(body, snippet, path.includes("messages"))
      }
    } catch {
      // Best-effort: continue without injection.
    }
    await next()
  }
}
