import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createSmtpSender,
  getMailSender,
  resolveMailConfig,
  setMailSenderForTesting,
} from "~/lib/mailer"

describe("resolveMailConfig", () => {
  test("is disabled without a host or sender", () => {
    expect(resolveMailConfig({})).toBeNull()
    expect(
      resolveMailConfig({ COPILOT_API_SMTP_HOST: "smtp.example.com" }),
    ).toBeNull()
  })

  test("reads the password from a file and applies defaults", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-mail-"))
    const file = path.join(dir, "pw")
    fs.writeFileSync(file, "s3cret\n")
    expect(
      resolveMailConfig({
        COPILOT_API_SMTP_HOST: " smtp.example.com ",
        COPILOT_API_SMTP_USER: "agents@example.com",
        COPILOT_API_SMTP_PASSWORD_FILE: file,
        COPILOT_API_SMTP_TLS_SERVERNAME: "mail.example.com",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "agents@example.com",
      password: "s3cret",
      from: "agents@example.com",
      tlsServername: "mail.example.com",
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("supports inline passwords, explicit sender, port and implicit TLS", () => {
    expect(
      resolveMailConfig({
        COPILOT_API_SMTP_HOST: "smtp.example.com",
        COPILOT_API_SMTP_PORT: "465",
        COPILOT_API_SMTP_SECURE: "true",
        COPILOT_API_SMTP_USER: "u@example.com",
        COPILOT_API_SMTP_PASSWORD: "pw",
        COPILOT_API_SMTP_FROM: "Gateway <noreply@example.com>",
      }),
    ).toMatchObject({
      port: 465,
      secure: true,
      password: "pw",
      from: "Gateway <noreply@example.com>",
    })
  })

  test("survives an unreadable password file", () => {
    expect(
      resolveMailConfig({
        COPILOT_API_SMTP_HOST: "smtp.example.com",
        COPILOT_API_SMTP_USER: "u@example.com",
        COPILOT_API_SMTP_PASSWORD_FILE: "/nonexistent/pw",
      })?.password,
    ).toBeUndefined()
  })

  test("sends through the transport and caches the sender", async () => {
    const send = createSmtpSender({
      host: "127.0.0.1",
      port: 9,
      secure: false,
      from: "a@example.com",
    })
    expect(typeof send).toBe("function")
    setMailSenderForTesting(undefined)
    const previous = process.env.COPILOT_API_SMTP_HOST
    delete process.env.COPILOT_API_SMTP_HOST
    expect(getMailSender()).toBeNull()
    if (previous !== undefined) process.env.COPILOT_API_SMTP_HOST = previous
    setMailSenderForTesting(undefined)
    const outcome = await send({
      to: "b@example.com",
      subject: "s",
      text: "t",
    }).then(
      () => "sent",
      () => "failed",
    )
    expect(outcome).toBe("failed")
  })
})
