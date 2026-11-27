import { Hono } from "hono"

import { isClaudeUserAgent } from "~/lib/catalog/claude-models"
import { filterModelCatalog } from "~/lib/http/model-catalog-filter"
import { requestContext } from "~/lib/http/request-context-store"
import { forwardError } from "~/lib/http/error"
import { handleClaudeModels } from "~/routes/models/claude-models"
import {
  handleCodexModels,
  isCodexUserAgent,
} from "~/routes/models/codex-models"
import { handleDefaultModels } from "~/routes/models/default-models"
import {
  handleOpencodeModels,
  isOpencodeUserAgent,
} from "~/routes/models/opencode-models"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const userAgent = c.req.header("user-agent")
    const response =
      isOpencodeUserAgent(userAgent) ? await handleOpencodeModels(c)
      : isCodexUserAgent(userAgent) ? await handleCodexModels(c)
      : isClaudeUserAgent(userAgent) ? await handleClaudeModels(c)
      : await handleDefaultModels(c)
    const key = requestContext.getStore()?.apiKey
    return key ? await filterModelCatalog(response, key) : response
  } catch (error) {
    return await forwardError(c, error)
  }
})
