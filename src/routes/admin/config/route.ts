import { Hono } from "hono"
import { z } from "zod"

import { forwardError } from "~/lib/http/error"
import { getModelMappings, setModelMappings } from "~/lib/config"
import { reloadServerConfig } from "~/lib/config/config-reload"
import {
  parseRouterConfig,
  RouterConfigError,
} from "~/lib/config/router-config"
import { PATHS } from "~/lib/storage/paths"
import { providerAdminRoutes } from "~/routes/admin/config/providers"
import {
  readEditableConfigFromDisk,
  writeConfigToDisk,
} from "~/lib/config/config-store"

export const configRoutes = new Hono()
configRoutes.route("/providers", providerAdminRoutes)

const modelMappingsRequestSchema = z.object({
  modelMappings: z.record(z.string(), z.string()),
})

configRoutes.post("/reload", async (c) => {
  try {
    await reloadServerConfig()
    return c.json({ configPath: PATHS.CONFIG_PATH, reloaded: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/model-mappings", (c) => {
  return c.json({
    configPath: PATHS.CONFIG_PATH,
    modelMappings: getModelMappings(),
  })
})

configRoutes.post("/model-mappings", async (c) => {
  try {
    const parseResult = modelMappingsRequestSchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const updatedModelMappings = setModelMappings(
      parseResult.data.modelMappings,
    )

    return c.json({
      configPath: PATHS.CONFIG_PATH,
      modelMappings: updatedModelMappings,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.get("/router", async (c) => {
  try {
    return c.json({
      configPath: PATHS.CONFIG_PATH,
      router: readEditableConfigFromDisk().router ?? {},
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.post("/router", async (c) => {
  try {
    const router = parseRouterConfig(await c.req.json())
    const config = readEditableConfigFromDisk()
    writeConfigToDisk({ ...config, router })
    await reloadServerConfig()
    return c.json({ configPath: PATHS.CONFIG_PATH, router })
  } catch (error) {
    if (error instanceof RouterConfigError) {
      return c.json(
        {
          error: {
            message: error.message,
            type: "invalid_request_error",
          },
        },
        400,
      )
    }
    return await forwardError(c, error)
  }
})

// Anthropic API key management
configRoutes.get("/anthropic/apikey", async (c) => {
  try {
    const config = readEditableConfigFromDisk()
    return c.json({ configured: Boolean(config.anthropicApiKey?.trim()) })
  } catch (error) {
    return await forwardError(c, error)
  }
})

const setAnthropicApiKeySchema = z.object({
  apiKey: z.string().min(1),
})

configRoutes.post("/anthropic/apikey", async (c) => {
  try {
    const parseResult = setAnthropicApiKeySchema.safeParse(await c.req.json())
    if (!parseResult.success) {
      return c.json(
        {
          error: {
            message:
              parseResult.error.issues[0]?.message ?? "Invalid request body.",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }

    const { apiKey } = parseResult.data
    const config = readEditableConfigFromDisk()
    writeConfigToDisk({
      ...config,
      anthropicApiKey: apiKey.trim(),
    })
    await reloadServerConfig()
    return c.json({ success: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})

configRoutes.delete("/anthropic/apikey", async (c) => {
  try {
    const config = readEditableConfigFromDisk()
    writeConfigToDisk({
      ...config,
      anthropicApiKey: undefined,
    })
    await reloadServerConfig()
    return c.json({ success: true })
  } catch (error) {
    return await forwardError(c, error)
  }
})
