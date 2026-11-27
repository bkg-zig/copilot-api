import { describe, expect, spyOn, test } from "bun:test"
import fsPromises from "node:fs/promises"

import * as config from "~/lib/config"

import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  isInvalidBindErrorCode,
  isLoopbackHostname,
  resolveClientHostname,
  resolveClientHostnameOrDefault,
  resolveServerBinding,
} from "~/lib/http/server-host"
import { createServer } from "~/server"
import * as subscriptions from "~/services/subscription-usage"

describe("server host security", () => {
  test("recognizes explicit loopback hosts", () => {
    expect(DEFAULT_SERVER_HOST).toBe("127.0.0.1")
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("127.0.0.2")).toBe(true)
    expect(isLoopbackHostname("[::1]")).toBe(true)
    expect(isLoopbackHostname("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("0:0::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("0.0.0.0")).toBe(false)
    expect(isLoopbackHostname("::")).toBe(false)
    expect(isLoopbackHostname("2001:db8::ffff:127.0.0.1")).toBe(false)
    expect(isLoopbackHostname("gateway.example.com")).toBe(false)
  })

  test("rejects non-loopback bindings without gateway api keys", () => {
    expect(() => resolveServerBinding("0.0.0.0", false)).toThrow(
      "Refusing to listen on non-loopback host",
    )
    expect(resolveServerBinding("0.0.0.0", true)).toEqual({
      hostname: "0.0.0.0",
      clientHostname: "127.0.0.1",
      networkExposed: true,
    })
    expect(resolveServerBinding("[::1]", false)).toEqual({
      hostname: "::1",
      clientHostname: "::1",
      networkExposed: false,
    })
    expect(() =>
      resolveServerBinding("2001:db8::ffff:127.0.0.1", false),
    ).toThrow("Refusing to listen on non-loopback host")
  })

  test("formats IPv4 and IPv6 listener URLs", () => {
    expect(formatServerUrl("127.0.0.1", 4141)).toBe("http://127.0.0.1:4141")
    expect(formatServerUrl("::1", 4141)).toBe("http://[::1]:4141")
  })

  test("dials wildcard binds through loopback", () => {
    expect(resolveClientHostname("0.0.0.0")).toBe("127.0.0.1")
    expect(resolveClientHostname("[::]")).toBe("127.0.0.1")
    expect(resolveClientHostname("::")).toBe("127.0.0.1")
    expect(resolveClientHostname("192.168.1.10")).toBe("192.168.1.10")
    expect(resolveClientHostname("127.0.0.1")).toBe("127.0.0.1")
  })

  test("falls back to loopback for a blank desktop host", () => {
    expect(resolveClientHostnameOrDefault("")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("   ")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault(null)).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault(undefined)).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("0.0.0.0")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("  ::  ")).toBe("127.0.0.1")
    expect(resolveClientHostnameOrDefault("  192.168.1.10  ")).toBe(
      "192.168.1.10",
    )
    expect(resolveClientHostnameOrDefault("::1")).toBe("::1")
  })
  test("classifies unbindable host errors separately from occupied ports", () => {
    expect(isInvalidBindErrorCode("ENOTFOUND")).toBe(true)
    expect(isInvalidBindErrorCode("EADDRNOTAVAIL")).toBe(true)
    expect(isInvalidBindErrorCode("EINVAL")).toBe(true)
    expect(isInvalidBindErrorCode("EAFNOSUPPORT")).toBe(true)
    expect(isInvalidBindErrorCode(undefined)).toBe(false)
    expect(isInvalidBindErrorCode("EADDRINUSE")).toBe(false)
    expect(isInvalidBindErrorCode("EACCES")).toBe(false)
  })
})

describe("network-exposed server policy", () => {
  test("keeps subscription usage available to the admin when regular keys are isolated", async () => {
    const usage = {
      provider: "codex" as const,
      planType: "business",
      windows: [],
      limitReached: false,
    }
    const configSpy = spyOn(config, "getConfig").mockReturnValue({
      auth: {
        adminApiKey: "admin",
        apiKeyConfigs: [{ id: "regular", key: "regular" }],
        isolateApiKeyUsage: true,
      },
    })
    const usageSpy = spyOn(
      subscriptions,
      "getSubscriptionUsage",
    ).mockResolvedValue(usage)
    try {
      const app = createServer()
      const request = (path: string, key: string) =>
        app.request(path, { headers: { "x-api-key": key } })
      expect((await request("/usage/codex", "regular")).status).toBe(403)
      expect((await request("/admin/usage/codex", "regular")).status).toBe(401)
      const response = await request("/admin/usage/codex", "admin")
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(usage)
      expect(usageSpy).toHaveBeenCalledTimes(1)
    } finally {
      usageSpy.mockRestore()
      configSpy.mockRestore()
    }
  })

  test("requires the separate admin key for provider administration", async () => {
    const configSpy = spyOn(config, "getConfig").mockReturnValue({
      auth: {
        adminApiKey: "admin",
        apiKeyConfigs: [{ id: "regular", key: "regular" }],
      },
    })
    try {
      const app = createServer()
      const body = JSON.stringify({
        name: "bkg-api",
        type: "openai-compatible",
        baseUrl: "https://provider.example",
        apiKey: "test-key",
      })
      const request = (key: string) =>
        app.request("/admin/config/providers", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
          },
          body,
        })

      expect((await request("regular")).status).toBe(401)
      // The reserved-name validation proves the request passed admin auth.
      expect((await request("admin")).status).toBe(400)
    } finally {
      configSpy.mockRestore()
    }
  })

  test("requires authentication for protected routes when no keys exist", async () => {
    const app = createServer({
      networkExposed: true,
      getApiKeys: () => [],
    })
    const response = await app.request("http://gateway.example.com/usage")

    expect(response.status).toBe(401)
  })

  test("allows only the request origin through CORS", async () => {
    const app = createServer({ networkExposed: true })
    const sameOriginResponse = await app.request(
      "http://gateway.example.com/",
      { headers: { origin: "http://gateway.example.com" } },
    )
    const crossOriginResponse = await app.request(
      "http://gateway.example.com/",
      { headers: { origin: "https://attacker.example.com" } },
    )

    expect(sameOriginResponse.headers.get("access-control-allow-origin")).toBe(
      "http://gateway.example.com",
    )
    expect(crossOriginResponse.headers.has("access-control-allow-origin")).toBe(
      false,
    )
  })

  test("keeps wildcard CORS for the default loopback server", async () => {
    const app = createServer()
    const response = await app.request("http://127.0.0.1/", {
      headers: { origin: "https://client.example.com" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "X-API-Key-Usage-Isolated",
    )
  })
})

describe("Copi web login gate", () => {
  test("shows the login/setup screen at the public root and does not expose the dashboard", async () => {
    const app = createServer({ networkExposed: true })
    const root = await app.request("https://copi.example/", { method: "GET" })
    const viewer = await app.request("https://copi.example/usage-viewer", {
      method: "GET",
    })

    expect(root.status).toBe(200)
    expect(viewer.status).toBe(200)
    const html = await root.text()
    expect(html).toContain("Administratorkonto einrichten")
    expect(html).toContain("bkg@eysho.info")
    expect(html).not.toContain('id="admin-tab"')
  })

  test("serves the full dashboard only after the session lookup accepts the browser cookie", async () => {
    const app = createServer({
      networkExposed: true,
      getWebAuthSession: (context) =>
        Promise.resolve(
          context.req.header("cookie") === "copi_session=valid-session-token" ?
            { id: 1, email: "bkg@eysho.info" }
          : null,
        ),
    })
    const locked = await app.request("https://copi.example/")
    const unlocked = await app.request("https://copi.example/", {
      headers: { cookie: "copi_session=valid-session-token" },
    })
    expect(await locked.text()).toContain("Administratorkonto einrichten")
    expect(await unlocked.text()).toContain('id="admin-tab"')
  })

  test("serves the shared BKG boilerplate and Copi workstation stylesheets", async () => {
    const app = createServer({ networkExposed: true })
    const boilerplate = await app.request(
      "https://copi.example/boilerplate.css",
    )
    const appStyles = await app.request("https://copi.example/copilot-ui.css")
    expect(boilerplate.status).toBe(200)
    expect(boilerplate.headers.get("content-type")).toContain("text/css")
    expect(await boilerplate.text()).toContain("--cyber-bg-deep")
    expect(appStyles.status).toBe(200)
    expect(await appStyles.text()).toContain(".playground-layout")
  })

  test("authenticated dashboard includes live model playground and all gateway protocol paths", async () => {
    const app = createServer({
      networkExposed: true,
      getWebAuthSession: (context) =>
        Promise.resolve(
          context.req.header("cookie") === "copi_session=valid-session-token" ?
            { id: 1, email: "bkg@eysho.info" }
          : null,
        ),
    })
    const response = await app.request("https://copi.example/", {
      headers: { cookie: "copi_session=valid-session-token" },
    })
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('id="side-nav"')
    expect(html).toContain('id="nav-toggle"')
    expect(html.indexOf("function stateAdminInit()")).toBeLessThan(
      html.indexOf("stateAdminInit();"),
    )
    expect(html).toContain("Model Playground")
    expect(html).toContain("/v1/chat/completions")
    expect(html).toContain("/v1/responses")
    expect(html).toContain("/v1/messages")
    expect(html).toMatch(
      /await fetchJson\(\s*deriveEndpointUrl\(\s*new URL\(endpoint, window\.location\.href\)\.toString\(\),\s*"models",?\s*\)/,
    )
    expect(html).toMatch(/if \(!Array\.isArray\(payload\?\.data\)\)/)
    expect(html).toContain("SUBSCRIPTION ACCOUNTS")
    expect(html).toContain("data-provider-auth-start")
    expect(html).toContain(
      '<span class="field-label">Gateway endpoint URL</span>',
    )
    expect(html).toContain('id="endpoint-url"')
    expect(html).toContain('value="/usage"')
    expect(html).not.toContain(">Endpoint URL</span>")
    expect(html).not.toContain("API key (nur für externe Endpunkte)")
    expect(html).not.toContain("copilot-api.usage-viewer.credential.")
    expect(html).toContain("OpenCode discovery")
    expect(html).toContain("Claude Code discovery")
    expect(html).not.toContain('id="x-api-key" class="input-control')
  })

  test("provider subscription login endpoints require a web session", async () => {
    const app = createServer({ networkExposed: true })
    const status = await app.request(
      "https://copi.example/auth/providers/status",
    )
    const start = await app.request(
      "https://copi.example/auth/providers/codex/start",
      { method: "POST" },
    )
    expect(status.status).toBe(401)
    expect(start.status).toBe(401)
  })

  test("a browser session is not accepted as a model API credential", async () => {
    const app = createServer({ networkExposed: true })
    const response = await app.request("https://copi.example/v1/models", {
      headers: { cookie: "copi_session=not-a-real-session-token" },
    })
    expect(response.status).toBe(401)
  })

  test("a browser session cookie alone does not authorize the admin password reset", async () => {
    const configSpy = spyOn(config, "getConfig").mockReturnValue({
      auth: {
        adminApiKey: "admin",
        apiKeyConfigs: [{ id: "regular", key: "regular" }],
      },
    })
    try {
      const app = createServer({
        networkExposed: true,
        getWebAuthSession: (context) =>
          Promise.resolve(
            (
              context.req.header("cookie")
                === "copi_session=valid-session-token"
            ) ?
              { id: 1, email: "bkg@eysho.info" }
            : null,
          ),
      })
      const response = await app.request(
        "https://copi.example/admin/auth/reset-password",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "copi_session=valid-session-token",
          },
          body: JSON.stringify({ password: "twelve-chars-minimum" }),
        },
      )
      expect(response.status).toBe(401)
    } finally {
      configSpy.mockRestore()
    }
  })

  test("serves the password reset UI on login and dashboard without storing the admin key in browser storage", async () => {
    const app = createServer({
      networkExposed: true,
      getWebAuthSession: (context) =>
        Promise.resolve(
          context.req.header("cookie") === "copi_session=valid-session-token" ?
            { id: 1, email: "bkg@eysho.info" }
          : null,
        ),
    })
    const login = await app.request("https://copi.example/")
    const dashboard = await app.request("https://copi.example/", {
      headers: { cookie: "copi_session=valid-session-token" },
    })
    const loginHtml = await login.text()
    const dashboardHtml = await dashboard.text()
    expect(loginHtml).toContain('id="reset-form"')
    expect(dashboardHtml).toContain("data-admin-reset-password")
    for (const html of [loginHtml, dashboardHtml]) {
      expect(html).toContain("/admin/auth/reset-password")
      expect(html).toContain('name="adminApiKey"')
      expect(html).toContain("Passwort zurücksetzen")
      expect(html).toContain(
        "Passwort aktualisiert. Alle Sitzungen wurden beendet. Bitte neu anmelden.",
      )
      const handler = html.match(
        /^(\s*)(?:async function submitPasswordReset\(event\) \{|if \(form\.matches\("\[data-admin-reset-password\]"\)\) \{)[\s\S]*?^\1\}\n/m,
      )
      expect(handler).not.toBeNull()
      expect(handler?.[0]).toContain('cache: "no-store"')
      expect(handler?.[0]).not.toMatch(
        /\b(?:localStorage|sessionStorage|document\.cookie)\b/,
      )
      expect(handler?.[0]).not.toContain("dataset.")
    }
  })
})

describe("web auth screen serving", () => {
  test("reads the login screen asynchronously in non-production and caches after retry in production", async () => {
    const app = createServer()
    const originalNodeEnv = process.env.NODE_ENV
    const readFileSpy = spyOn(fsPromises, "readFile")

    try {
      process.env.NODE_ENV = "test"
      const devFirst = await app.request("/usage-viewer")
      const devSecond = await app.request("/usage-viewer")
      expect(devFirst.status).toBe(200)
      expect(devSecond.status).toBe(200)
      expect(await devFirst.text()).toContain("<!doctype html>")
      expect(readFileSpy).toHaveBeenCalledTimes(2)

      readFileSpy.mockClear()
      process.env.NODE_ENV = "production"
      readFileSpy.mockRejectedValueOnce(new Error("transient read failure"))

      const failed = await app.request("/usage-viewer")
      expect(failed.status).toBe(500)

      const [prodFirst, prodSecond] = await Promise.all([
        app.request("/usage-viewer"),
        app.request("/usage-viewer"),
      ])
      const prodThird = await app.request("/usage-viewer")
      expect(prodFirst.status).toBe(200)
      expect(prodSecond.status).toBe(200)
      expect(prodThird.status).toBe(200)
      expect(await prodThird.text()).toContain("<!doctype html>")
      // 1 rejected read + 1 shared successful read cached across concurrent & follow-up calls
      expect(readFileSpy).toHaveBeenCalledTimes(2)

      const redirect = await app.request("/usage-viewer/")
      expect(redirect.status).toBe(301)
      expect(redirect.headers.get("location")).toBe("/usage-viewer")
    } finally {
      readFileSpy.mockRestore()
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
    }
  })
})
