import { describe, expect, test } from "bun:test"

import { readServerSentEventData } from "~/services/chatgpt/sse"

function streamOf(
  chunks: Array<string>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunk))
    },
    cancel() {
      onCancel?.()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const payloads: Array<string> = []
  for await (const data of readServerSentEventData(stream)) {
    payloads.push(data)
  }
  return payloads
}

describe("readServerSentEventData", () => {
  test("yields data payloads of LF and CRLF separated events", async () => {
    expect(
      await readAll(
        streamOf([
          'data: "v1"\n\n',
          'data: {"a":1}\r\n\r\n',
          "data: [DONE]\n\n",
        ]),
      ),
    ).toEqual(['"v1"', '{"a":1}', "[DONE]"])
  })

  test("handles events and CRLF pairs split across chunks", async () => {
    expect(
      await readAll(
        streamOf(["da", 'ta: {"x":', "2}\r", "\n\r", "\ndata: y\n\n"]),
      ),
    ).toEqual(['{"x":2}', "y"])
  })

  test("joins multi-line data and ignores comments and other fields", async () => {
    expect(
      await readAll(
        streamOf([
          ": keep-alive\n\n",
          "event: delta\nid: 7\nretry: 10\ndata: a\ndata: b\n\n",
          "data\n\n",
          "data:no-space\n\n",
        ]),
      ),
    ).toEqual(["a\nb", "", "no-space"])
  })

  test("yields a final event without trailing blank line", async () => {
    expect(await readAll(streamOf(["data: last"]))).toEqual(["last"])
  })

  test("cancels the body when the consumer stops early", async () => {
    let cancelled = false
    const stream = streamOf(["data: 1\n\n", "data: 2\n\n"], () => {
      cancelled = true
    })
    for await (const data of readServerSentEventData(stream)) {
      expect(data).toBe("1")
      break
    }
    expect(cancelled).toBe(true)
  })
})
