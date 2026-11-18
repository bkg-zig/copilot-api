import { afterEach, describe, expect, test } from "bun:test"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { setupCopilotModeWithFallback } from "~/start"

const failingSetup = (): Promise<void> =>
  Promise.reject(
    new Error("Failed to get Copilot token (GitHub responded 401)"),
  )

const originalSetupError = state.copilotSetupError

afterEach(() => {
  state.copilotSetupError = originalSetupError
})

describe("setupCopilotModeWithFallback", () => {
  test("remembers GitHub's reason for the dashboard until Copilot starts", async () => {
    await setupCopilotModeWithFallback("github-token", "file", ["codex"], () =>
      Promise.reject(
        new HTTPError(
          "Failed to get Copilot token (GitHub responded 403)",
          Response.json(
            {
              error_details: {
                message: "Your account's billing is currently locked.",
              },
            },
            { status: 403 },
          ),
        ),
      ),
    )
    expect(state.copilotSetupError).toBe(
      "Your account's billing is currently locked.",
    )

    await setupCopilotModeWithFallback("github-token", "file", ["codex"], () =>
      Promise.resolve(),
    )
    expect(state.copilotSetupError).toBeUndefined()
  })

  test("continues in provider-only mode when other providers are enabled", async () => {
    const result = await setupCopilotModeWithFallback(
      "github-token",
      "file",
      ["codex"],
      failingSetup,
    )

    expect(result).toBe(false)
  })

  test("fails with an actionable re-login hint when Copilot is the only provider", async () => {
    const error = await setupCopilotModeWithFallback(
      "github-token",
      "file",
      [],
      failingSetup,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("Failed to get Copilot token")
    expect((error as Error).message).toContain("copilot-api auth login")
    expect((error as Error).cause).toBeInstanceOf(Error)
  })

  test("returns true when Copilot setup succeeds", async () => {
    const result = await setupCopilotModeWithFallback(
      "github-token",
      "env",
      [],
      () => Promise.resolve(),
    )

    expect(result).toBe(true)
  })
})
