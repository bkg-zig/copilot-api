import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ProviderConfig } from "~/lib/config-store"
import {
  createWebAdminRoutes,
  findWebInstance,
  resetWebAdminStates,
  type WebAdminDeps,
} from "~/routes/admin/web/route"
import { WebSessionError, type WebProviderAdapter } from "~/services/web/types"

const fakeAdapter: WebProviderAdapter = {
  id: "claude-web",
  displayName: "Claude (Web)",
  webUrl: "https://claude.ai",
  loginHint: "Paste a claude.ai fetch capture.",
  sessionKinds: ["cookie", "fetch-capture"],
  validateSession: (input) =>
    input.value?.includes("good") ?
      Promise.resolve({ accountLabel: "Max", modelCount: 3 })
    : Promise.reject(
        new WebSessionError(
          401,
          "web_session_expired",
          "Paste a claude.ai fetch capture.",
          "session rejected",
        ),
      ),
  listModels: () =>
    Promise.resolve([
      {
        capabilities: {
          family: "anthropic",
          limits: {},
          object: "model_capabilities",
          supports: { streaming: true },
          tokenizer: "o200k_base",
          type: "chat",
        },
        id: "claude-sonnet-4-6",
        model_picker_enabled: true,
        name: "Claude Sonnet",
        object: "model",
        preview: false,
        vendor: "anthropic",
        version: "web",
      } as never,
    ]),
  chatCompletion: () =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: "OK" } }],
      }),
    ),
}

function makeApp() {
  let providers: Record<string, ProviderConfig> = {}
  const deps: WebAdminDeps = {
    adapters: () => [fakeAdapter],
    getAdapter: (id) => (id === "claude-web" ? fakeAdapter : null),
    readProviders: () => providers,
    saveProvider: (name, provider) => {
      providers = { ...providers, [name]: provider }
    },
    writeProviders: (next) => {
      providers = { ...next }
    },
  }
  resetWebAdminStates()
  const app = new Hono()
  app.route("/admin/web", createWebAdminRoutes(deps))
  return {
    app,
    getProviders: () => providers,
  }
}

describe("web admin routes", () => {
  test("lists adapters as unconfigured without leaking anything", async () => {
    const { app } = makeApp()
    const response = await app.request("/admin/web/providers")
    const body = (await response.json()) as {
      providers: Array<{ id: string; status: string }>
    }
    expect(response.status).toBe(200)
    expect(body.providers[0]).toMatchObject({
      id: "claude-web",
      status: "unconfigured",
    })
    expect(JSON.stringify(body)).not.toContain("sessionKey")
  })

  test("saves a fetch capture as cookie and never returns the secret", async () => {
    const { app, getProviders } = makeApp()
    const capture = `fetch("https://claude.ai/api/organizations/x/completion", {headers: {"cookie": "sessionKey=supersecretvalue"}})`
    const response = await app.request(
      "/admin/web/providers/claude-web/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "fetch-capture", value: capture }),
      },
    )
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain("supersecretvalue")
    expect(text).toContain("sessionKey")
    expect(getProviders()["claude-web"]?.cookie).toContain("supersecretvalue")
  })

  test("validate marks a good session active and a bad one expired", async () => {
    const { app } = makeApp()
    await app.request("/admin/web/providers/claude-web/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cookie", value: "sessionKey=good-one" }),
    })
    const ok = await app.request("/admin/web/providers/claude-web/validate", {
      method: "POST",
    })
    expect(ok.status).toBe(200)

    await app.request("/admin/web/providers/claude-web/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cookie", value: "sessionKey=bad-one" }),
    })
    const bad = await app.request("/admin/web/providers/claude-web/validate", {
      method: "POST",
    })
    expect(bad.status).toBe(401)
    const list = (await (await app.request("/admin/web/providers")).json()) as {
      providers: Array<{ status: string }>
    }
    expect(list.providers[0].status).toBe("expired")
  })

  test("findWebInstance matches legacy chatgpt and web entries", () => {
    expect(
      findWebInstance("chatgpt", { chatgpt: { type: "chatgpt" } })?.name,
    ).toBe("chatgpt")
    expect(
      findWebInstance("claude-web", {
        mine: { type: "web", webAdapter: "claude-web" },
      })?.name,
    ).toBe("mine")
    expect(findWebInstance("qwen-web", {})).toBeNull()
  })
})
