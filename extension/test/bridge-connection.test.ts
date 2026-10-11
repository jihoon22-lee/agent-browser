import { BridgeConnection, type ConnStatus } from "../src/background/bridge-connection";
import { makeOk, makeErr, parseEnvelope } from "../src/protocol/envelope";

class FakeWs {
  static last: FakeWs;
  sent: string[] = [];
  readyState = 0;
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
  constructor(public url: string) { FakeWs.last = this; }
  send(t: string) { this.sent.push(t); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  reply(env: unknown) { this.onmessage?.({ data: JSON.stringify(env) }); }
}

function setup(store: Record<string, unknown> = { pairingToken: "tok", clientId: "cli-1" }) {
  vi.useFakeTimers();
  const statuses: ConnStatus[] = [];
  const requests: string[] = [];
  const conn = new BridgeConnection({
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    storage: { get: async (k: string) => store[k], set: async (k: string, v: unknown) => { store[k] = v; } },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
    onRequest: async (req) => { requests.push(req.method); return { echoed: req.method }; },
    onStatus: (s) => statuses.push(s),
  });
  return { conn, statuses, store, requests };
}

describe("BridgeConnection", () => {
  afterEach(() => vi.useRealTimers());

  it("sends auth.hello first and never puts the token in the URL", async () => {
    const { conn } = setup();
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    expect(FakeWs.last.url).toBe("ws://127.0.0.1:4317/extension");
    FakeWs.last.open();
    const hello = parseEnvelope(FakeWs.last.sent[0]!);
    expect(hello.type === "req" && hello.method).toBe("auth.hello");
    expect(hello.type === "req" && hello.params.token).toBe("tok");
    expect(FakeWs.last.url).not.toContain("tok");
  });

  it("reports unpaired without a token and does not connect", async () => {
    const { conn, statuses } = setup({});
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    expect(statuses.at(-1)?.state).toBe("unpaired");
  });

  it("does not retry after AUTH_FAILED", async () => {
    const { conn, statuses } = setup();
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeWs.last;
    ws.open();
    const hello = parseEnvelope(ws.sent[0]!);
    ws.reply(makeErr(hello.type === "req" ? hello.id : "", { code: "AUTH_FAILED", message: "bad", retry: "never" }));
    ws.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.last).toBe(ws);
    expect(statuses.at(-1)?.state).toBe("auth_failed");
  });

  it("reconnects with backoff after an unexpected close", async () => {
    const { conn } = setup();
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    const first = FakeWs.last;
    first.open();
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWs.last).not.toBe(first);
  });

  it("answers bridge requests through onRequest", async () => {
    const { conn } = setup();
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeWs.last;
    ws.open();
    const hello = parseEnvelope(ws.sent[0]!);
    ws.reply(makeOk(hello.type === "req" ? hello.id : "", { selected: true }));
    ws.reply({ v: 1, type: "req", id: "r1", method: "browser.tabs.list", params: {} });
    // Flush promises only; running timers would also fire the 20s heartbeat and bury the response.
    await vi.advanceTimersByTimeAsync(0);
    const res = ws.sent.map((t) => parseEnvelope(t)).find((e) => e.type === "res" && e.id === "r1");
    expect(res).toMatchObject({ type: "res", id: "r1", ok: true, result: { echoed: "browser.tabs.list" } });
  });

  it("closes and reconnects when heartbeat gets no answer", async () => {
    const { conn } = setup();
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeWs.last;
    ws.open();
    const hello = parseEnvelope(ws.sent[0]!);
    ws.reply(makeOk(hello.type === "req" ? hello.id : "", { selected: true }));
    await vi.advanceTimersByTimeAsync(20_000 + 10_000 + 1_000 + 1);
    expect(FakeWs.last).not.toBe(ws);
  });

  it("does not execute commands that arrive before auth.hello is acknowledged", async () => {
    const { conn, requests } = setup();
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    const ws = FakeWs.last;
    ws.open();
    ws.reply({ v: 1, type: "req", id: "early", method: "browser.click", params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([]);
    const refusal = ws.sent.map((t) => parseEnvelope(t)).find((e) => e.type === "res" && e.id === "early");
    expect(refusal).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    // once the hello is acknowledged the same kind of command is served
    const hello = parseEnvelope(ws.sent[0]!);
    ws.reply(makeOk(hello.type === "req" ? hello.id : "", { selected: true }));
    await vi.advanceTimersByTimeAsync(0);
    ws.reply({ v: 1, type: "req", id: "late", method: "browser.click", params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(["browser.click"]);
  });
});
