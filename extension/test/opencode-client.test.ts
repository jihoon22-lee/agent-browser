import { describe, it, expect, vi } from "vitest";
import { OpenCodeV1Client, OpenCodeApiError, parseSse } from "../src/agents/opencode-v1/client";

const connection = { baseUrl: "http://127.0.0.1:4096", directory: "C:\\작업 폴더\\a+b", username: "opencode", password: "한글:암호" };

describe("pinned OpenCode v1 transport", () => {
  it("invokes the browser's native fetch with its required global receiver", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = function(this: unknown) { expect(this).toBe(globalThis); return Promise.resolve(new Response("[]")); };
    try { expect(await new OpenCodeV1Client(connection).get("/session")).toEqual([]); }
    finally { globalThis.fetch = original; }
  });
  it("keeps credentials in headers and encodes directory/queries without corrupting Windows paths", async () => {
    const fetcher = vi.fn(async () => new Response("[]", { status: 200 }));
    const client = new OpenCodeV1Client(connection, fetcher);
    await client.get("/session", { search: "한글 & 검색" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("directory")).toBe(connection.directory);
    expect(parsed.searchParams.get("search")).toBe("한글 & 검색");
    expect(url).not.toContain(connection.password);
    expect(new Headers(init.headers).get("Authorization")).toBe("Basic " + Buffer.from("opencode:한글:암호").toString("base64"));
    expect(init.redirect).toBe("error");
  });
  it("rejects v2 paths and alternate origins before fetching, and never retries a mutation", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("network lost"); });
    const client = new OpenCodeV1Client(connection, fetcher);
    for (const path of ["/api/session", "https://other.test/session", "//other.test/session", "/session/../api/session"]) await expect(client.get(path)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.post("/session", { title: "합성" })).rejects.toThrow("network lost");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("handles 204 and preserves structured errors without logging passwords", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(JSON.stringify({ name: "NotFoundError", message: "Already answered" }), { status: 404 }));
    const client = new OpenCodeV1Client(connection, fetcher);
    expect(await client.post("/session/ses_fixture/prompt_async", { parts: [] })).toBeUndefined();
    try { await client.post("/question/q_fixture/reply", { answers: [["예"]] }); throw new Error("Expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(OpenCodeApiError); expect((error as OpenCodeApiError).status).toBe(404); expect(String(error)).not.toContain(connection.password); }
  });
  it("parses fragmented UTF-8, CRLF and multiline SSE data while ignoring comments", async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\nid: wire-id\r\ndata: {"type":"message.part.delta",\r\ndata: "properties":{"delta":"한글"}}\r\n\r\n');
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
    const events = [];
    for await (const event of parseSse(stream)) events.push(event);
    expect(events).toEqual([{ id: "wire-id", type: "message.part.delta", properties: { delta: "한글" } }]);
  });
  it("reconnects with authentication and resync notification, deduplicates event IDs, and stops on abort", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response('data: {"id":"evt_1","type":"server.connected","properties":{}}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const events: unknown[] = [], connections: boolean[] = [];
    const client = new OpenCodeV1Client(connection, fetcher, { retryDelayMs: 0 });
    await client.events(event => events.push(event), connected => { connections.push(connected); if (connections.filter(Boolean).length === 2) controller.abort(); }, controller.signal);
    expect(events).toHaveLength(1);
    expect(connections.filter(Boolean)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) expect(new Headers(init.headers).get("Authorization")).toMatch(/^Basic /);
  });
  it("does not reconnect forever after authentication failure", async () => {
    const fetcher = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
    const client = new OpenCodeV1Client(connection, fetcher, { retryDelayMs: 0 });
    await expect(client.events(() => {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("falls back to the server directory listing when the native file index has no matches", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("[]")).mockResolvedValueOnce(new Response(JSON.stringify([
      { name: "합성 파일.txt", path: "문서/합성 파일.txt", type: "file", ignored: false },
      { name: "합성 자료", path: "문서/합성 자료", type: "directory", ignored: false },
      { name: "다른 이름", path: "문서/다른 이름", type: "file", ignored: false },
    ])));
    const client = new OpenCodeV1Client(connection, fetcher);
    expect(await client.findFiles("문서/합성")).toEqual(["문서/합성 자료/", "문서/합성 파일.txt"]);
    expect(new URL(fetcher.mock.calls[1]![0] as string).searchParams.get("path")).toBe("문서/");
  });
});
