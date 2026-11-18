import { describe, expect, test } from "bun:test"

import {
  ChatGPTWebDeltaDecoder,
  type ChatGPTWebStreamEvent,
} from "~/services/chatgpt/delta-stream"

function feed(
  decoder: ChatGPTWebDeltaDecoder,
  payloads: Array<unknown>,
): Array<ChatGPTWebStreamEvent> {
  const events: Array<ChatGPTWebStreamEvent> = []
  for (const payload of payloads) {
    events.push(
      ...decoder.push(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      ),
    )
  }
  return events
}

function message(
  id: string,
  role: string,
  parts: Array<string>,
  extra: Record<string, unknown> = {},
) {
  return {
    author: { metadata: {}, name: null, role },
    content: { content_type: "text", parts },
    end_turn: null,
    id,
    metadata: {},
    status: "in_progress",
    ...extra,
  }
}

const conversationId = "6af88afe-262c-83eb-9005-1aead05f443c"

// Shape of a real gpt-6-t-mini turn (abbreviated): echo of the request,
// hidden system messages, a reasoning recap, then the visible answer that is
// built by patch operations with inherited `p`/`o` fields.
const realisticTurn: Array<unknown> = [
  '"v1"',
  {
    conversation_id: conversationId,
    kind: "topic",
    token: "resume-token",
    type: "resume_conversation_token",
  },
  { content: null, type: "ads" },
  {
    o: "add",
    p: "",
    v: {
      conversation_id: conversationId,
      error: null,
      message: message("user-1", "user", ["Count from 1 to 5."], {
        status: "finished_successfully",
      }),
    },
  },
  {
    v: {
      conversation_id: conversationId,
      error: null,
      message: message("system-1", "system", [""], {
        end_turn: true,
        metadata: { is_visually_hidden_from_conversation: true },
        status: "finished_successfully",
      }),
    },
  },
  {
    conversation_id: conversationId,
    event: "first",
    marker: "cot_token",
    message_id: "recap-1",
    type: "message_marker",
  },
  {
    v: {
      conversation_id: conversationId,
      error: null,
      message: {
        ...message("recap-1", "assistant", []),
        content: {
          content: "Worked for a second",
          content_type: "reasoning_recap",
        },
        end_turn: false,
        status: "finished_successfully",
      },
    },
  },
  {
    v: {
      conversation_id: conversationId,
      error: null,
      message: message("answer-1", "assistant", [""], {
        end_turn: false,
        metadata: {
          is_visually_hidden_from_conversation: true,
          model_slug: "gpt-6-t-mini",
        },
      }),
    },
  },
  {
    o: "patch",
    v: [
      { o: "append", p: "/message/content/parts/0", v: "1 " },
      { o: "replace", p: "/message/end_turn", v: null },
      {
        o: "remove",
        p: "/message/metadata/is_visually_hidden_from_conversation",
      },
      { o: "append", p: "/message/metadata", v: { citations: [] } },
    ],
  },
  {
    v: [
      { o: "append", p: "/message/content/parts/0", v: "2 " },
      {
        o: "append",
        p: "/message/metadata/model_dil_v2/constants",
        v: { 0: "1 2 " },
      },
    ],
  },
  { v: [{ o: "append", p: "/message/content/parts/0", v: "3 4 5" }] },
  {
    v: [
      { o: "replace", p: "/message/status", v: "finished_successfully" },
      { o: "replace", p: "/message/end_turn", v: true },
      {
        o: "append",
        p: "/message/metadata",
        v: { finish_details: { stop_tokens: [200002], type: "stop" } },
      },
    ],
  },
  {
    metadata: { model_slug: "gpt-6-t-mini", plan_type: "free" },
    type: "server_ste_metadata",
  },
  { conversation_id: conversationId, type: "message_stream_complete" },
  { conversation_id: conversationId, type: "conversation_detail_metadata" },
  "[DONE]",
]

describe("ChatGPTWebDeltaDecoder", () => {
  test("decodes a realistic delta-encoded turn", () => {
    const decoder = new ChatGPTWebDeltaDecoder({
      ignoredMessageIds: ["user-1"],
    })
    const events = feed(decoder, realisticTurn)
    expect(events).toEqual([
      { messageId: "answer-1", text: "1 ", type: "text" },
      { messageId: "answer-1", text: "2 ", type: "text" },
      { messageId: "answer-1", text: "3 4 5", type: "text" },
    ])
    expect(decoder.finish()).toEqual([
      {
        conversationId,
        finishReason: "stop",
        modelSlug: "gpt-6-t-mini",
        type: "done",
      },
    ])
    expect(decoder.resolvedModelSlug).toBe("gpt-6-t-mini")
  })

  test("skips echoed history, internal tool calls and analysis messages", () => {
    const decoder = new ChatGPTWebDeltaDecoder({
      ignoredMessageIds: ["history-assistant"],
    })
    const events = feed(decoder, [
      {
        o: "add",
        p: "",
        v: { message: message("history-assistant", "assistant", ["old"]) },
      },
      {
        v: {
          message: message("tool-1", "assistant", ["print(1)"], {
            recipient: "python",
          }),
        },
      },
      {
        v: {
          message: message("analysis-1", "assistant", ["thinking"], {
            channel: "analysis",
          }),
        },
      },
      {
        v: {
          message: message("visible", "assistant", ["Hi"], {
            recipient: "all",
          }),
        },
      },
      { v: { message: { id: 5 } } },
      { v: "ignored: root append of a string" },
    ])
    expect(events).toEqual([{ messageId: "visible", text: "Hi", type: "text" }])
  })

  test("accepts complete envelopes of the legacy encoding", () => {
    const decoder = new ChatGPTWebDeltaDecoder()
    const events = feed(decoder, [
      { message: message("m", "assistant", ["Hel"]) },
      { message: message("m", "assistant", ["Hello"]) },
      {
        conversation_id: "c-1",
        message: message("m", "assistant", ["Hello!"], {
          end_turn: true,
          status: "finished_successfully",
        }),
      },
    ])
    expect(
      events.map((event) => (event.type === "text" ? event.text : "")),
    ).toEqual(["Hel", "lo", "!"])
    expect(decoder.finish()).toEqual([
      {
        conversationId: "c-1",
        finishReason: "stop",
        modelSlug: undefined,
        type: "done",
      },
    ])
  })

  test("reports max_tokens as length and continues after a rewrite", () => {
    const decoder = new ChatGPTWebDeltaDecoder()
    const events = feed(decoder, [
      { o: "add", p: "", v: { message: message("m", "assistant", ["abc"]) } },
      { o: "replace", p: "/message/content/parts/0", v: "xyz1" },
      { o: "append", p: "/message/content/parts/0", v: "2" },
      { o: "truncate", p: "/message/content/parts/0", v: 2 },
      {
        o: "patch",
        v: [
          { o: "replace", p: "/message/status", v: "finished_successfully" },
          { o: "replace", p: "/message/end_turn", v: true },
          {
            o: "add",
            p: "/message/metadata/finish_details",
            v: { type: "max_tokens" },
          },
        ],
      },
    ])
    // A rewrite cannot be retracted downstream: it is skipped, later appends
    // stream again, and a truncation emits nothing.
    expect(events).toEqual([
      { messageId: "m", text: "abc", type: "text" },
      { messageId: "m", text: "2", type: "text" },
    ])
    expect(decoder.finish()[0]).toMatchObject({
      finishReason: "length",
      type: "done",
    })
  })

  test("supports array indices, nested containers and guarded keys", () => {
    const decoder = new ChatGPTWebDeltaDecoder()
    feed(decoder, [
      { o: "add", p: "", v: { message: message("m", "assistant", []) } },
      { o: "add", p: "/message/content/parts/0", v: "a" },
      { o: "add", p: "/message/metadata/list/0/name", v: "x" },
      { o: "add", p: "/message/metadata/list/-1", v: "ignored" },
      { o: "append", p: "/message/metadata/list", v: ["y"] },
      { o: "remove", p: "/message/metadata/list/0" },
      { o: "remove", p: "/message/metadata/missing/key" },
      { o: "add", p: "/__proto__/polluted", v: true },
      { o: "add", p: "/message/a~1b~0c", v: 1 },
      { o: "unknown", p: "/message/x", v: 1 },
      { o: "truncate", p: "/message/metadata/list", v: "bad" },
    ])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const events = decoder.push(
      JSON.stringify({ o: "append", p: "/message/content/parts/0", v: "b" }),
    )
    expect(events).toEqual([{ messageId: "m", text: "b", type: "text" }])
  })

  test("turns moderation blocks, stream errors and envelope errors into errors", () => {
    const blocked = new ChatGPTWebDeltaDecoder()
    expect(
      feed(blocked, [
        { moderation_response: { blocked: false }, type: "moderation" },
        { moderation_response: { blocked: true }, type: "moderation" },
        { message: message("m", "assistant", ["after"]) },
      ]),
    ).toEqual([
      {
        code: "content_filter",
        message: "ChatGPT blocked this response (moderation).",
        type: "error",
      },
    ])
    expect(blocked.finish()).toEqual([])

    const failed = new ChatGPTWebDeltaDecoder()
    expect(
      feed(failed, [
        { error: { message: "Something went wrong" }, type: "error" },
      ]),
    ).toEqual([
      {
        code: "chatgpt_stream_error",
        message: "Something went wrong",
        type: "error",
      },
    ])

    const generic = new ChatGPTWebDeltaDecoder()
    expect(feed(generic, [{ type: "error" }])[0]).toMatchObject({
      message: "ChatGPT reported an error while generating the response.",
    })

    const envelope = new ChatGPTWebDeltaDecoder()
    expect(
      feed(envelope, [
        { o: "add", p: "", v: { error: " Too many requests ", message: null } },
      ]),
    ).toEqual([
      {
        code: "chatgpt_stream_error",
        message: "Too many requests",
        type: "error",
      },
    ])
  })

  test("reports an exhausted usage limit with its reset time", () => {
    const decoder = new ChatGPTWebDeltaDecoder({
      ignoredMessageIds: ["user-1"],
    })
    // Shape of a real answer of a free account whose thinking limit is used up.
    expect(
      feed(decoder, [
        '"v1"',
        { o: "add", p: "", v: { message: message("user-1", "user", ["hi"]) } },
        {
          conversation_id: conversationId,
          error: "You've hit your limit. Please try again later.",
          error_code: "usage_limit",
          message: null,
        },
        { v: { message: message("late", "assistant", ["ignored"]) } },
        {
          metadata: { model_slug: "gpt-6-t-mini", plan_type: "free" },
          type: "server_ste_metadata",
        },
        {
          conversation_id: conversationId,
          limits_progress: [
            {
              feature_name: "file_upload",
              remaining: 3,
              reset_after: "2026-11-14T20:00:00Z",
            },
            {
              feature_name: "deep_research",
              remaining: 0,
              reset_after: "2026-11-20T00:00:00Z",
            },
            {
              feature_name: "reason",
              remaining: 0,
              reset_after: "2026-11-14T21:22:29.051149+00:00",
            },
            { feature_name: "broken", remaining: 0, reset_after: "not a date" },
            "not a record",
          ],
          type: "conversation_detail_metadata",
        },
        "[DONE]",
      ]),
    ).toEqual([])
    expect(decoder.finish()).toEqual([
      {
        code: "chatgpt_usage_limit",
        message:
          "You've hit your limit. Please try again later. The ChatGPT web limit 'reason' resets at 2026-11-14 21:22 UTC.",
        resetAt: "2026-11-14T21:22:29.051Z",
        type: "error",
      },
    ])
  })

  test("reports usage limits without reset data and other error codes", () => {
    const limited = new ChatGPTWebDeltaDecoder()
    feed(limited, [
      { error: "Limit reached.", error_code: "usage_limit", message: null },
      { limits_progress: "n/a", type: "conversation_detail_metadata" },
    ])
    expect(limited.finish()).toEqual([
      { code: "chatgpt_usage_limit", message: "Limit reached.", type: "error" },
    ])

    const unnamed = new ChatGPTWebDeltaDecoder()
    feed(unnamed, [
      { error: "Limit reached.", error_code: "usage_limit", message: null },
      {
        limits_progress: [
          { remaining: 0, reset_after: "2026-11-14T22:00:00Z" },
        ],
        type: "conversation_detail_metadata",
      },
      "[DONE]",
    ])
    expect(unnamed.finish()[0]).toMatchObject({
      message:
        "Limit reached. The ChatGPT web limit 'usage' resets at 2026-11-14 22:00 UTC.",
      resetAt: "2026-11-14T22:00:00.000Z",
    })

    const typed = new ChatGPTWebDeltaDecoder()
    feed(typed, [
      { error: "Too many.", error_code: "usage_limit", type: "error" },
      "[DONE]",
    ])
    expect(typed.finish()[0]).toMatchObject({ code: "chatgpt_usage_limit" })

    const other = new ChatGPTWebDeltaDecoder()
    expect(
      feed(other, [
        {
          error: "Conversation not found",
          error_code: "conversation_not_found",
          message: null,
        },
      ]),
    ).toEqual([
      {
        code: "chatgpt_stream_error",
        message: "Conversation not found (conversation_not_found)",
        type: "error",
      },
    ])
  })

  test("reports a finished turn without any answer", () => {
    const decoder = new ChatGPTWebDeltaDecoder({
      ignoredMessageIds: ["user-1"],
    })
    feed(decoder, [
      '"v1"',
      { o: "add", p: "", v: { message: message("user-1", "user", ["hi"]) } },
      { conversation_id: conversationId, type: "message_stream_complete" },
      "[DONE]",
    ])
    expect(decoder.finish()).toEqual([
      {
        code: "chatgpt_empty_response",
        message: "ChatGPT web finished the turn without an answer.",
        type: "error",
      },
    ])
  })

  test("reports an incomplete stream and ignores malformed payloads", () => {
    const decoder = new ChatGPTWebDeltaDecoder()
    expect(feed(decoder, ["", "not json", "[1,2]", { foo: 1 }])).toEqual([])
    expect(decoder.finish()).toEqual([
      {
        code: "chatgpt_stream_incomplete",
        message: "ChatGPT web stream ended before the response was complete.",
        type: "error",
      },
    ])
    expect(decoder.push('"v1"')).toEqual([])
  })
})
