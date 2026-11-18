/**
 * Minimal server-sent events reader that yields the `data` payload of each
 * event. Unlike a plain iterator over the body it owns the stream reader, so
 * stopping early (return/throw) cancels the upstream response instead of
 * leaving the connection open.
 */
export async function* readServerSentEventData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: Array<string> = []

  const processLine = (line: string): string | undefined => {
    if (line === "") {
      if (data.length === 0) return undefined
      const payload = data.join("\n")
      data = []
      return payload
    }
    if (line.startsWith(":")) return undefined
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field !== "data") return undefined
    const value = colon < 0 ? "" : line.slice(colon + 1)
    data.push(value.startsWith(" ") ? value.slice(1) : value)
    return undefined
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer +=
        done ? decoder.decode() : decoder.decode(value, { stream: true })
      // A trailing CR may be the first half of a CRLF split across chunks.
      const heldCarriageReturn = !done && buffer.endsWith("\r")
      const text = heldCarriageReturn ? buffer.slice(0, -1) : buffer
      const lines = text.split(/\r\n|\r|\n/u)
      buffer =
        done ? "" : `${lines.pop() ?? ""}${heldCarriageReturn ? "\r" : ""}`
      for (const line of lines) {
        const payload = processLine(line)
        if (payload !== undefined) yield payload
      }
      if (done) {
        if (data.length > 0) yield data.join("\n")
        return
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
