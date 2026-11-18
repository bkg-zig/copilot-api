import { describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  describeCopilotSetupError,
  readGitHubErrorMessage,
} from "~/lib/github-error-message"

const httpError = (body: unknown, status = 403) =>
  new HTTPError(
    "GitHub failed",
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    }),
  )

describe("GitHub error messages", () => {
  test("prefers GitHub's detailed explanation and keeps the body readable", async () => {
    const error = httpError({
      error_details: {
        message: "Your account's billing is currently locked.",
        notification_id: "billing_locked",
      },
      message: "Forbidden",
    })

    expect(await readGitHubErrorMessage(error)).toBe(
      "Your account's billing is currently locked.",
    )
    expect(await error.response.text()).toContain("billing_locked")
  })

  test("falls back to the top-level message", async () => {
    expect(
      await readGitHubErrorMessage(
        httpError(
          { error_details: { message: " " }, message: "Bad credentials" },
          401,
        ),
      ),
    ).toBe("Bad credentials")
  })

  test("returns nothing for other errors and unreadable answers", async () => {
    expect(await readGitHubErrorMessage(new Error("offline"))).toBeUndefined()
    expect(await readGitHubErrorMessage(httpError("not json"))).toBeUndefined()
    expect(await readGitHubErrorMessage(httpError([1, 2]))).toBeUndefined()
    expect(
      await readGitHubErrorMessage(httpError({ message: 42 })),
    ).toBeUndefined()
  })

  test("cleans and shortens the text before the dashboard shows it", async () => {
    const message = await readGitHubErrorMessage(
      httpError({ message: `line one\n\tline\u0007two ${"x".repeat(400)}` }),
    )

    expect(message?.startsWith("line one line two x")).toBe(true)
    expect(message).toHaveLength(300)
    expect(message?.endsWith("…")).toBe(true)
  })

  test("hides a token that GitHub repeats back", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    const message = await readGitHubErrorMessage(
      httpError({ message: `Token ${token} is not valid` }, 401),
    )

    expect(message).toStartWith("Token ghp_")
    expect(message).not.toContain(token)
  })
})

describe("Copilot setup failure reason", () => {
  test("uses GitHub's words, then the status, then a general hint", async () => {
    expect(
      await describeCopilotSetupError(
        httpError({ error_details: { message: "Billing is locked." } }),
      ),
    ).toBe("Billing is locked.")
    expect(await describeCopilotSetupError(httpError("", 502))).toBe(
      "GitHub answered HTTP 502.",
    )
    expect(await describeCopilotSetupError(new Error("socket hang up"))).toBe(
      "Copilot could not start. See the server log.",
    )
  })
})
