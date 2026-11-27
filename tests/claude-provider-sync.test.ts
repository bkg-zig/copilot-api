import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  invalidateConfigCache,
  readEditableConfigFromDisk,
  setConfigPathOverride,
} from "~/lib/config/config-store"
import { resolveProviderEntry } from "~/lib/config/provider-config"
import { syncClaudeProviderConfig } from "~/lib/auth/claude-code/provider"

test("anthropic oauth2 is configured without a stored API key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-provider-config-"))
  const configPath = path.join(dir, "config.json")
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      providers: {
        anthropic: {
          type: "anthropic",
          authType: "oauth2",
          baseUrl: "https://api.anthropic.com",
        },
      },
    })}\n`,
  )
  setConfigPathOverride(configPath)
  try {
    const stored = readEditableConfigFromDisk().providers?.anthropic
    expect(stored).toBeDefined()
    expect(resolveProviderEntry("anthropic", stored!)).toMatchObject({
      name: "anthropic",
      type: "anthropic",
      authType: "oauth2",
      apiKey: "",
    })
    // Die OAuth2-Ausnahme gilt nur für die bekannten Abo-Anbieter; ein
    // frei benannter Provider braucht weiterhin einen gespeicherten Key.
    expect(
      resolveProviderEntry("custom-oauth", {
        type: "anthropic",
        authType: "oauth2",
        baseUrl: "https://api.anthropic.com",
      }),
    ).toBeNull()
  } finally {
    setConfigPathOverride(null)
  }
})

test("syncClaudeProviderConfig stores oauth fields and keeps model filters", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-provider-sync-"))
  const configPath = path.join(dir, "config.json")
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      providers: {
        anthropic: {
          type: "anthropic",
          apiKey: "sk-ant-old",
          modelsDevProviderId: "anthropic",
          agentsModels: ["claude-sonnet"],
          baseUrl: " https://api.anthropic.com ",
          enabled: false,
        },
      },
    })}\n`,
  )
  setConfigPathOverride(configPath)
  try {
    syncClaudeProviderConfig(false)
    const disabled = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      providers: {
        anthropic: {
          authType: string
          apiKey?: string
          enabled: boolean
          agentsModels: string[]
          modelsDevProviderId?: string
        }
      }
    }
    expect(disabled.providers.anthropic.authType).toBe("oauth2")
    expect(disabled.providers.anthropic.apiKey).toBeUndefined()
    expect(disabled.providers.anthropic.modelsDevProviderId).toBeUndefined()
    expect(disabled.providers.anthropic.enabled).toBe(false)
    expect(disabled.providers.anthropic.agentsModels).toEqual(["claude-sonnet"])

    syncClaudeProviderConfig(true)
    const enabled = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      providers: { anthropic: { enabled: boolean; baseUrl: string } }
    }
    expect(enabled.providers.anthropic.enabled).toBe(true)
    expect(enabled.providers.anthropic.baseUrl).toBe(
      "https://api.anthropic.com",
    )

    fs.writeFileSync(configPath, "{}\n")
    invalidateConfigCache()
    syncClaudeProviderConfig()
    const created = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      providers: {
        anthropic: { type: string; baseUrl: string; enabled: boolean }
      }
    }
    expect(created.providers.anthropic.type).toBe("anthropic")
    expect(created.providers.anthropic.baseUrl).toBe(
      "https://api.anthropic.com",
    )
    expect(created.providers.anthropic.enabled).toBe(true)
  } finally {
    setConfigPathOverride(null)
  }
})
