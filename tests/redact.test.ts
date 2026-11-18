import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createHandlerLogger, shutdownLoggerRuntime } from "~/lib/logger"
import {
  isSecretKey,
  redactText,
  redactValue,
  sanitizeForDiagnostics,
} from "~/lib/redact"

const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const originalLogDir = process.env[LOG_DIR_ENV]

afterEach(() => {
  shutdownLoggerRuntime()
  if (originalLogDir === undefined) {
    Reflect.deleteProperty(process.env, LOG_DIR_ENV)
  } else {
    process.env[LOG_DIR_ENV] = originalLogDir
  }
})

describe("isSecretKey", () => {
  test("recognizes secret-shaped keys by meaning, not only exact names", () => {
    expect(isSecretKey("apiKey")).toBe(true)
    expect(isSecretKey("access_token")).toBe(true)
    // Variants not spelled like the canonical names above.
    expect(isSecretKey("githubCopilotCredentialValue")).toBe(true)
    expect(isSecretKey("client-passphrase")).toBe(true)
    expect(isSecretKey("X-Api-Key")).toBe(true)
    expect(isSecretKey("model")).toBe(false)
    expect(isSecretKey("author")).toBe(false)
    expect(isSecretKey("promptLimit")).toBe(false)
  })
})

describe("redactText", () => {
  test("redacts bearer tokens, provider keys and JWTs in free text", () => {
    // Secrets are assembled at runtime so this fixture stays a real secret.
    const bearerSecret = ["abcdef", "123456", "7890"].join("")
    const providerKey = ["sk", "ant", "1234567890abcdef"].join("-")
    const jwt = [
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "payloadpart123456",
      "signaturepart",
    ].join(".")
    const ghKey = ["ghp", "1234567890abcdefghijklmnopqrstuv"].join("_")
    const text = [
      `Authorization: Bearer ${bearerSecret}`,
      `key ${providerKey}`,
      `jwt ${jwt}`,
      `gh ${ghKey}`,
    ].join(" ")

    const redacted = redactText(text)

    expect(redacted).not.toContain(bearerSecret)
    expect(redacted).not.toContain(providerKey)
    expect(redacted).not.toContain("payloadpart123456")
    expect(redacted).not.toContain(ghKey)
    expect(redacted).toContain("<redacted>")
  })

  test("redacts key/value pairs in JSON and inspect-style output", () => {
    expect(redactText('{"apiKey": "supersecretvalue"}')).not.toContain(
      "supersecretvalue",
    )
    expect(redactText("{ refreshToken: 'supersecretvalue' }")).not.toContain(
      "supersecretvalue",
    )
    expect(redactText("token=supersecretvalue&model=gpt-5")).not.toContain(
      "supersecretvalue",
    )
    expect(redactText("token=supersecretvalue&model=gpt-5")).toContain(
      "model=gpt-5",
    )
  })

  test("keeps ordinary text untouched", () => {
    expect(redactText("model gpt-5 finished in 12ms")).toBe(
      "model gpt-5 finished in 12ms",
    )
  })
})

describe("redactValue", () => {
  test("redacts secret-shaped values at any depth and keeps the rest", () => {
    const value = {
      model: "gpt-5",
      nested: {
        nestedCredentialMaterial: "do-not-leak-me",
        items: [{ password: "do-not-leak-me" }, { ok: 1 }],
      },
    }

    const redacted = redactValue(value) as {
      model: string
      nested: { items: Array<Record<string, unknown>> }
    }

    expect(JSON.stringify(redacted)).not.toContain("do-not-leak-me")
    expect(redacted.model).toBe("gpt-5")
    expect(redacted.nested.items[1]).toEqual({ ok: 1 })
  })

  test("fails closed on circular values instead of leaking or throwing", () => {
    const value: Record<string, unknown> = { token: "do-not-leak-me" }
    value.self = value

    expect(JSON.stringify(redactValue(value))).not.toContain("do-not-leak-me")
  })
})

describe("handler logger redaction", () => {
  test("secrets logged through a handler logger never reach the log file", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-redact-"))
    process.env[LOG_DIR_ENV] = logDir

    try {
      const bearerSecret = ["abcdef", "123456", "7890"].join("")
      const logger = createHandlerLogger("redact-handler")
      for (let index = 0; index < 100; index += 1) {
        logger.error(
          `entry-${index} apiKey=do-not-leak-me Bearer ${bearerSecret}`,
        )
      }

      const dateKey = new Date().toLocaleDateString("sv-SE")
      const filePath = path.join(logDir, `redact-handler-${dateKey}.log`)
      let content = ""
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (fs.existsSync(filePath)) {
          content = fs.readFileSync(filePath, "utf8")
          if (content.includes("entry-99")) break
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      expect(content).toContain("entry-99")
      expect(content).not.toContain("do-not-leak-me")
      expect(content).not.toContain(bearerSecret)
      expect(content).toContain("<redacted>")
    } finally {
      shutdownLoggerRuntime()
      fs.rmSync(logDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    }
  })
})

describe("sanitizeForDiagnostics", () => {
  test("bounds depth, arrays and strings and redacts secrets", () => {
    const value = {
      apiKey: "do-not-leak-me",
      list: Array.from({ length: 500 }, (_, index) => index),
      deep: { a: { b: { c: { d: { e: { f: "x".repeat(5000) } } } } } },
    }

    const sanitized = sanitizeForDiagnostics(value) as {
      list: Array<unknown>
    }
    const serialized = JSON.stringify(sanitized)

    expect(serialized).not.toContain("do-not-leak-me")
    expect(serialized.length).toBeLessThan(20000)
    expect(sanitized.list.length).toBeLessThanOrEqual(101)
  })
})
