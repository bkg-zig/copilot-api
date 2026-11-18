import fs from "node:fs"

import consola from "consola"
import nodemailer from "nodemailer"

/**
 * Outgoing mail for dashboard sign-in links (setup, invitations, password
 * resets). Configured only through the environment so credentials never end up
 * in config.json:
 *
 * - COPILOT_API_SMTP_HOST, COPILOT_API_SMTP_PORT (default 587)
 * - COPILOT_API_SMTP_USER and COPILOT_API_SMTP_PASSWORD_FILE (preferred) or
 *   COPILOT_API_SMTP_PASSWORD
 * - COPILOT_API_SMTP_FROM (defaults to the SMTP user)
 * - COPILOT_API_SMTP_SECURE=true for implicit TLS (port 465); otherwise
 *   STARTTLS is required.
 * - COPILOT_API_SMTP_TLS_SERVERNAME to verify the certificate against a name
 *   other than the host (e.g. when dialing the host gateway).
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface MailConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  password?: string
  from: string
  tlsServername?: string
}

export type MailSender = (message: MailMessage) => Promise<void>

function readPassword(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.COPILOT_API_SMTP_PASSWORD_FILE?.trim()
  if (file) {
    try {
      return fs.readFileSync(file, "utf8").trim()
    } catch (error) {
      consola.warn(
        `Could not read COPILOT_API_SMTP_PASSWORD_FILE: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
  return env.COPILOT_API_SMTP_PASSWORD || undefined
}

export function resolveMailConfig(
  env: NodeJS.ProcessEnv = process.env,
): MailConfig | null {
  const host = env.COPILOT_API_SMTP_HOST?.trim()
  if (!host) return null
  const port = Number.parseInt(env.COPILOT_API_SMTP_PORT ?? "", 10)
  const user = env.COPILOT_API_SMTP_USER?.trim() || undefined
  const from = env.COPILOT_API_SMTP_FROM?.trim() || user
  if (!from) return null
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: env.COPILOT_API_SMTP_SECURE === "true",
    user,
    password: user ? readPassword(env) : undefined,
    from,
    tlsServername: env.COPILOT_API_SMTP_TLS_SERVERNAME?.trim() || undefined,
  }
}

export function createSmtpSender(config: MailConfig): MailSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth:
      config.user ?
        { user: config.user, pass: config.password ?? "" }
      : undefined,
    tls:
      config.tlsServername ? { servername: config.tlsServername } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  })
  return async (message) => {
    await transport.sendMail({ from: config.from, ...message })
  }
}

let sender: MailSender | null | undefined

/** Returns the configured sender, or null when mail is not set up. */
export function getMailSender(): MailSender | null {
  if (sender === undefined) {
    const config = resolveMailConfig()
    sender = config ? createSmtpSender(config) : null
  }
  return sender
}

export function setMailSenderForTesting(
  next: MailSender | null | undefined,
): void {
  sender = next
}
