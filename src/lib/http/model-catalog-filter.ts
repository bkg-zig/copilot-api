import { getModelMappings } from "../config"
import {
  isApiKeyModelAllowed,
  type GatewayApiKeyConfig,
} from "../config/api-key-config"

function catalogModelId(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null
  const record = entry as Record<string, unknown>
  const id = record.id ?? record.slug
  return typeof id === "string" && id ? id : null
}

function isAllowedCatalogModel(
  id: string,
  key: GatewayApiKeyConfig,
  visited: Set<string>,
): boolean {
  if (visited.has(id)) return false
  visited.add(id)

  const separator = id.indexOf("/")
  if (separator > 0) {
    const provider = id.slice(0, separator)
    const model = id.slice(separator + 1)
    if (isApiKeyModelAllowed(key, model, provider)) return true
    if (isApiKeyModelAllowed(key, model)) return true
  }
  if (isApiKeyModelAllowed(key, id)) return true

  const mapped = getModelMappings()[id]
  return Boolean(
    mapped && mapped !== id && isAllowedCatalogModel(mapped, key, visited),
  )
}

/** Filters a discovery response to the models released for the request key. */
export async function filterModelCatalog(
  response: Response,
  key: GatewayApiKeyConfig,
): Promise<Response> {
  if (key.allowedModels === undefined) return response
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("json") || !response.ok) return response

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return response
  }
  if (!body || typeof body !== "object") return response

  const record = { ...(body as Record<string, unknown>) }
  let changed = false
  for (const field of ["data", "models"]) {
    const entries = record[field]
    if (!Array.isArray(entries)) continue
    changed = true
    record[field] = entries.filter((entry) => {
      const id = catalogModelId(entry)
      return id === null || isAllowedCatalogModel(id, key, new Set())
    })
  }
  if (!changed) return response

  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("etag")
  return new Response(JSON.stringify(record), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
