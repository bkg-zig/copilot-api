import { describe, expect, test } from "bun:test"

import {
  comboModelId,
  isRetryableComboError,
  orderComboTargets,
  runComboFailover,
} from "~/lib/combo"
import { HTTPError, UpstreamHeadersTimeoutError } from "~/lib/error"
import type { ComboTarget } from "~/lib/config-store"

const target = (
  provider: string,
  model: string,
  extra: Partial<ComboTarget> = {},
): ComboTarget => ({ provider, model, weight: 1, ...extra })

describe("comboModelId", () => {
  test("joins provider and model", () => {
    expect(comboModelId("nv", "z-ai/glm-5.3-flash")).toBe(
      "nv/z-ai/glm-5.3-flash",
    )
  })
})

describe("orderComboTargets", () => {
  test("keeps regular order and moves last-resort targets to the end", () => {
    const ordered = orderComboTargets([
      target("nv", "a"),
      target("oc", "b", { lastResort: true }),
      target("nv", "c"),
      target("oc", "d", { lastResort: true }),
    ])
    expect(ordered.map((entry) => entry.model)).toEqual(["a", "c", "b", "d"])
  })
})

describe("isRetryableComboError", () => {
  test("retries upstream HTTP and timeout failures", () => {
    expect(
      isRetryableComboError(
        new HTTPError("x", new Response("", { status: 429 })),
      ),
    ).toBe(true)
    expect(isRetryableComboError(new UpstreamHeadersTimeoutError(1000))).toBe(
      true,
    )
  })

  test("does not retry unrelated errors", () => {
    expect(isRetryableComboError(new Error("boom"))).toBe(false)
    expect(isRetryableComboError("boom")).toBe(false)
  })
})

describe("runComboFailover", () => {
  test("returns the first successful response without trying later targets", async () => {
    const attempted: Array<string> = []
    const response = await runComboFailover({
      comboModel: "combo/coding-free",
      targets: [target("nv", "a"), target("nv", "b")],
      run: (model) => {
        attempted.push(model)
        return new Response("ok", { status: 200 })
      },
    })
    expect(await response.text()).toBe("ok")
    expect(attempted).toEqual(["nv/a"])
  })

  test("fails over to the next target after a retryable HTTP error", async () => {
    const attempted: Array<string> = []
    const response = await runComboFailover({
      comboModel: "combo/coding-free",
      targets: [target("oc", "dead"), target("nv", "alive")],
      run: (model) => {
        attempted.push(model)
        if (model === "oc/dead") {
          throw new HTTPError(
            "rate limited",
            new Response("nope", { status: 429 }),
          )
        }
        return new Response("alive", { status: 200 })
      },
    })
    expect(await response.text()).toBe("alive")
    expect(attempted).toEqual(["oc/dead", "nv/alive"])
  })

  test("fails over after a non-ok response and returns the last one when all fail", async () => {
    const response = await runComboFailover({
      comboModel: "combo/best-free",
      targets: [target("nv", "a"), target("nv", "b")],
      run: (model) =>
        new Response(model, { status: model === "nv/a" ? 500 : 503 }),
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe("nv/b")
  })

  test("returns the upstream error response when every target throws", async () => {
    const response = await runComboFailover({
      comboModel: "combo/best-free",
      targets: [target("oc", "a"), target("oc", "b")],
      run: () => {
        throw new HTTPError("nope", new Response("denied", { status: 402 }))
      },
    })
    expect(response.status).toBe(402)
  })

  test("tries last-resort targets only after the regular ones", async () => {
    const attempted: Array<string> = []
    await runComboFailover({
      comboModel: "combo/best-free",
      targets: [
        target("anthropic", "fable", { lastResort: true }),
        target("nv", "primary"),
      ],
      run: (model) => {
        attempted.push(model)
        return new Response("ok", { status: 200 })
      },
    })
    expect(attempted).toEqual(["nv/primary"])
  })

  test("rethrows errors that are not retryable", () => {
    expect(
      runComboFailover({
        comboModel: "combo/best-free",
        targets: [target("nv", "a")],
        run: () => {
          throw new Error("programmer error")
        },
      }),
    ).rejects.toThrow("programmer error")
  })

  test("throws when there are no targets", () => {
    expect(
      runComboFailover({
        comboModel: "combo/empty",
        targets: [],
        run: () => new Response("never"),
      }),
    ).rejects.toThrow("no available target")
  })
})
