import { apiKeyPolicyMiddleware } from "./lib/api-key-policy"
import { apiKeyManagementRoutes } from "./routes/admin/api-keys/manage-route"
import { apiKeyUsageRoutes } from "./routes/admin/api-keys/route"
import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { readFileSync } from "node:fs"

import {
  createAuthMiddleware,
  getConfiguredAdminApiKeys,
  getConfiguredApiCreatorApiKeys,
  isCreatorAllowedPath,
} from "./lib/request-auth"
import { traceIdMiddleware } from "./lib/trace"
import type { GatewayPlugins } from "./lib/gateway-plugins"
import { requestEventsMiddleware } from "./lib/request-events"
import { alphaSearchRoutes } from "./routes/alpha-search/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { configRoutes } from "./routes/admin/config/route"
import { authRoutes, getRequestSession } from "./routes/auth/route"
import { diagnosticsRoutes } from "./routes/admin/diagnostics/route"
import { webAdminRoutes } from "./routes/admin/web/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { healthRoutes } from "./routes/health/route"
import { imageRoutes } from "./routes/images/route"
import { memoryAdminRoutes, memoryRoutes } from "./routes/memory/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerAlphaSearchRoutes } from "./routes/provider/alpha-search/route"
import { providerImageRoutes } from "./routes/provider/images/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { providerResponsesRoutes } from "./routes/provider/responses/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { usageRoute } from "./routes/usage/route"
import { videoRoutes } from "./routes/videos/route"
export interface CreateServerOptions {
  networkExposed?: boolean
  getApiKeys?: () => Array<string>
  port?: number
  plugins?: GatewayPlugins
  allowedOrigins?: string[]
}

function resolveSameOriginCorsOrigin(
  origin: string,
  context: Context,
): string | null {
  if (!origin) {
    return null
  }

  try {
    return origin === new URL(context.req.url).origin ? origin : null
  } catch {
    return null
  }
}

export function createServer(options: CreateServerOptions = {}): Hono {
  const server = new Hono()
  const networkExposed = options.networkExposed ?? false
  const allowedOrigins = options.allowedOrigins ?? []

  server.use(traceIdMiddleware)
  server.use(logger())
  server.use(
    allowedOrigins.length > 0 ?
      cors({
        // Explicit allowlist (COPILOT_API_ALLOWED_ORIGINS).
        origin: (origin) =>
          origin && allowedOrigins.includes(origin) ? origin : null,
        credentials: true,
        allowHeaders: [
          "Content-Type",
          "Authorization",
          "x-api-key",
          "x-requested-with",
        ],
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
        exposeHeaders: ["x-trace-id", "X-API-Key-Usage-Isolated"],
        maxAge: 86400,
      })
    : networkExposed ?
      cors({
        origin: resolveSameOriginCorsOrigin,
        exposeHeaders: ["X-API-Key-Usage-Isolated"],
      })
    : cors({ exposeHeaders: ["X-API-Key-Usage-Isolated"] }),
  )
  server.use(
    "*",
    createAuthMiddleware({
      getApiKeys: options.getApiKeys,
      allowUnauthenticatedPaths: [
        "/",
        "/health",
        "/v1/health",
        "/usage-viewer",
        "/usage-viewer/",
        "/favicon.ico",
      ],
      shouldSkipPath: (path) =>
        path.startsWith("/admin/") || path.startsWith("/auth/"),
      isAuthorizedBySession: async (c) => (await getRequestSession(c)) !== null,
      allowWhenNoApiKeys: !networkExposed,
    }),
  )
  // Admin-only gate. The API-key management and token-usage/monitoring routes
  // are exempted so the restricted creator key can reach them; a dedicated
  // middleware below re-authenticates those paths with admin OR creator
  // credentials.
  server.use(
    "/admin/*",
    createAuthMiddleware({
      getApiKeys: getConfiguredAdminApiKeys,
      allowUnauthenticatedPaths: [],
      isAuthorizedBySession: async (c) =>
        (await getRequestSession(c))?.role === "admin",
      allowWhenNoApiKeys: false,
      shouldSkipPath: isCreatorAllowedPath,
    }),
  )

  // API-key management + monitoring: the admin key/session keeps full access,
  // while the restricted creator key may only list/create keys (enforced per
  // method in the handlers) and read token usage.
  const creatorScopeAuth = createAuthMiddleware({
    getApiKeys: () => [
      ...getConfiguredAdminApiKeys(),
      ...getConfiguredApiCreatorApiKeys(),
    ],
    allowUnauthenticatedPaths: [],
    isAuthorizedBySession: async (c) =>
      (await getRequestSession(c))?.role === "admin",
    allowWhenNoApiKeys: false,
  })
  server.use("/admin/api-keys", creatorScopeAuth)
  server.use("/admin/api-keys/*", creatorScopeAuth)
  server.use("/admin/token-usage", creatorScopeAuth)
  server.use("/admin/token-usage/*", creatorScopeAuth)

  server.use("*", apiKeyPolicyMiddleware)

  server.use(
    "*",
    requestEventsMiddleware(options.plugins, options.port ?? 4141),
  )

  server.get("/", (c) => {
    const usageViewerFileUrl = new URL("../pages/index.html", import.meta.url)
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    c.header("Pragma", "no-cache")
    return c.html(readFileSync(usageViewerFileUrl, "utf8"))
  })
  server.get("/favicon.ico", (c) =>
    c.redirect(
      "https://cdn.jsdelivr.net/npm/@iconify/json@1.1.600/logos/github-copilot.svg",
      302,
    ),
  )
  server.get("/usage-viewer", (c) => {
    const usageViewerFileUrl = new URL("../pages/index.html", import.meta.url)
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    c.header("Pragma", "no-cache")
    return c.html(readFileSync(usageViewerFileUrl, "utf8"))
  })
  server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))

  server.route("/health", healthRoutes)
  server.route("/v1/health", healthRoutes)
  server.route("/chat/completions", completionRoutes)
  server.route("/admin/config", configRoutes)
  server.route("/admin/diagnostics", diagnosticsRoutes)
  server.route("/admin/web", webAdminRoutes)
  server.route("/auth", authRoutes)
  server.route("/models", modelRoutes)
  server.route("/embeddings", embeddingRoutes)
  server.route("/usage", usageRoute)
  server.route("/admin/usage", usageRoute)
  server.route("/token-usage", tokenUsageRoute)
  server.route("/admin/token-usage", tokenUsageRoute)
  server.route("/admin/api-keys/usage", apiKeyUsageRoutes)
  server.route("/admin/api-keys", apiKeyManagementRoutes)
  server.route("/responses", responsesRoutes)
  server.route("/alpha/search", alphaSearchRoutes)
  server.route("/images", imageRoutes)
  server.route("/videos", videoRoutes)
  server.route("/memory", memoryRoutes)
  server.route("/admin/memory", memoryAdminRoutes)

  // Compatibility with tools that expect v1/ prefix
  server.route("/v1/chat/completions", completionRoutes)
  server.route("/v1/models", modelRoutes)
  server.route("/v1/embeddings", embeddingRoutes)
  server.route("/v1/responses", responsesRoutes)
  server.route("/v1/alpha/search", alphaSearchRoutes)
  server.route("/v1/images", imageRoutes)
  server.route("/v1/videos", videoRoutes)
  server.route("/v1/memory", memoryRoutes)

  // Anthropic compatible endpoints
  server.route("/v1/messages", messageRoutes)

  // Provider scoped endpoints
  server.route("/:provider/v1/messages", providerMessageRoutes)
  server.route("/:provider/v1/models", providerModelRoutes)
  server.route("/:provider/v1/responses", providerResponsesRoutes)
  server.route("/:provider/v1/alpha/search", providerAlphaSearchRoutes)
  server.route("/:provider/v1/images", providerImageRoutes)

  server.route("/:provider/models", providerModelRoutes)
  server.route("/:provider/responses", providerResponsesRoutes)
  server.route("/:provider/alpha/search", providerAlphaSearchRoutes)
  server.route("/:provider/images", providerImageRoutes)

  return server
}
