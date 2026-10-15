import { createHmac, webcrypto } from "node:crypto";
import { BridgeConnection, compareVersions, type ConnStatus, type ConnDeps } from "../src/background/bridge-connection";
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

function setup(store: Record<string, unknown> = { pairingToken: "tok", clientId: "cli-1" }, overrides: Partial<ConnDeps> = {}) {
  vi.useFakeTimers();
  vi.stubGlobal("crypto", webcrypto);
  const statuses: ConnStatus[] = [];
  const requests: string[] = [];
  const onDisconnect = vi.fn();
  const conn = new BridgeConnection({
    WebSocketImpl: FakeWs as unknown as typeof WebSocket,
    storage: { get: async (k: string) => store[k], set: async (k: string, v: unknown) => { store[k] = v; } },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
    onRequest: async (req) => { requests.push(req.method); return { echoed: req.method }; },
    onStatus: (s) => statuses.push(s),
    onDisconnect,
    ...overrides,
  });
  return { conn, statuses, store, requests, onDisconnect };
}

describe("BridgeConnection", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("sends auth.hello first and never puts the token in the URL", async () => {
    const { conn } = setup();
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    expect(FakeWs.last.url).toBe("ws://127.0.0.1:4317/extension");
    FakeWs.last.open();
    const hello = parseEnvelope(FakeWs.last.sent[0]!);
    expect(hello.type === "req" && hello.method).toBe("auth.hello");
    expect(hello.type === "req" && hello.params).toMatchObject({ authVersion: 1, role: "extension", clientId: "cli-1" });
    expect(hello.type === "req" && hello.params).not.toHaveProperty("token");
    expect(FakeWs.last.url).not.toContain("tok");
  });

  it("asks the Bridge for a token without one and stores it from an open pairing window", async () => {
    const { conn, store, statuses } = setup({ clientId: "cli-1" });
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    expect(statuses.at(-1)?.state).toBe("unpaired");
    const pairing = FakeWs.last; pairing.open();
    const request = parseEnvelope(pairing.sent[0]!);
    expect(request.type === "req" && request.method).toBe("pair.request");
    pairing.reply(makeOk((request as any).id, { token: "a".repeat(64) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.pairingToken).toBe("a".repeat(64));
    expect(store.repairPending).toBe(true);
    FakeWs.last.open();
    const hello = parseEnvelope(FakeWs.last.sent[0]!);
    expect(hello.type === "req" && hello.method).toBe("auth.hello");
  });

  it("keeps asking every few seconds while no pairing window is open", async () => {
    const { conn } = setup({ clientId: "cli-1" });
    conn.start();
    await vi.runOnlyPendingTimersAsync();
    const first = FakeWs.last; first.open();
    first.reply(makeErr((parseEnvelope(first.sent[0]!) as any).id, { code: "AUTH_REQUIRED", message: "closed", retry: "never" }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeWs.last).not.toBe(first);
    FakeWs.last.open();
    expect(parseEnvelope(FakeWs.last.sent[0]!)).toMatchObject({ method: "pair.request" });
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
    await finishAuthentication(ws);
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
    await finishAuthentication(ws);
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
    await finishAuthentication(ws);
    await vi.advanceTimersByTimeAsync(0);
    ws.reply({ v: 1, type: "req", id: "late", method: "browser.click", params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual(["browser.click"]);
  });
});


function nodeProof(side: string, params: Record<string, unknown>, serverNonce: string, token = "tok") {
  return createHmac("sha256", token).update(JSON.stringify([
    "agent-browser-auth-v1", side, params.role, params.clientId, params.clientNonce, serverNonce, params.repair,
  ])).digest("hex");
}

async function finishAuthentication(ws: FakeWs, ack: Record<string, unknown> = { authVersion: 1, selected: true }) {
  const hello = parseEnvelope(ws.sent[0]!);
  if (hello.type !== "req") throw new Error("Expected hello request");
  const serverNonce = "22".repeat(32);
  ws.reply(makeOk(hello.id, { authVersion: 1, serverNonce, serverProof: nodeProof("server", hello.params, serverNonce) }));
  await vi.waitFor(() => expect(ws.sent.map(parseEnvelope).some((req) => req.type === "req" && req.method === "auth.prove")).toBe(true));
  const prove = ws.sent.map(parseEnvelope).find((req) => req.type === "req" && req.method === "auth.prove");
  if (prove?.type !== "req") throw new Error("Expected client proof");
  expect(prove.params).toEqual({ authVersion: 1, proof: nodeProof("client", hello.params, serverNonce) });
  ws.reply(makeOk(prove.id, ack));
}

async function authenticatedWith(conn: BridgeConnection, ack: Record<string, unknown>) {
  conn.start();
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeWs.last;
  ws.open();
  await finishAuthentication(ws, ack);
  await vi.advanceTimersByTimeAsync(0);
  return ws;
}

async function authenticated(conn: BridgeConnection) {
  conn.start();
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeWs.last;
  ws.open();
  await finishAuthentication(ws);
  return ws;
}

describe("BridgeConnection lifecycle", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("reloads at most once per newer Bridge version", async () => {
    const reload = vi.fn();
    const { conn, store } = setup({ pairingToken: "tok", clientId: "cli-1" }, { extensionVersion: "0.1.11", reload });
    await authenticatedWith(conn, { authVersion: 1, serverVersion: "0.1.12" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.reloadedForBridge).toBe("0.1.12");
    conn.stop();
    await authenticatedWith(conn, { authVersion: 1, serverVersion: "0.1.12" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads for an equal or older Bridge", async () => {
    const reload = vi.fn();
    const { conn } = setup({ pairingToken: "tok", clientId: "cli-1" }, { extensionVersion: "0.1.11", reload });
    await authenticatedWith(conn, { authVersion: 1, serverVersion: "0.1.11" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("compares release versions numerically", () => {
    expect(compareVersions("0.1.12", "0.1.11")).toBeGreaterThan(0);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.11", "0.1.11")).toBe(0);
    expect(compareVersions("0.2.0-beta", "0.2.0")).toBe(0);
  });

  it.each(["close", "stop"] as const)("rejects pending panel requests on %s and notifies once", async (action) => {
    const { conn, onDisconnect } = setup();
    const ws = await authenticated(conn);
    const result = conn.request("status.get", {}).catch((error: unknown) => error);
    if (action === "stop") conn.stop(); else ws.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject({ code: "BROWSER_DISCONNECTED" });
    expect(conn.status().state).toBe("disconnected");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    ws.onclose?.();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("times out unanswered panel requests without disconnecting a healthy socket", async () => {
    const { conn } = setup();
    const ws = await authenticated(conn);
    const result = conn.request("status.get", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await Promise.race([result, Promise.resolve("still pending")])).toMatchObject({ code: "TIMEOUT" });
    expect(ws.readyState).toBe(1);
    expect(conn.status().state).toBe("connected");
  });

  it.each([false, true])("reconnects if the socket never completes authentication (open=%s)", async (open) => {
    const { conn } = setup();
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.last;
    if (open) ws.open();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(ws.readyState).toBe(3);
    expect(FakeWs.last).not.toBe(ws);
  });

  it("sends tab.closed only while authenticated", async () => {
    const { conn } = setup();
    expect(conn.sendEvent("tab.closed", { tabId: 7 })).toBe(false);
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.last;
    ws.open();
    expect(conn.sendEvent("tab.closed", { tabId: 7 })).toBe(false);
    await finishAuthentication(ws);
    expect(conn.sendEvent("tab.closed", { tabId: 7 })).toBe(true);
    expect(parseEnvelope(ws.sent.at(-1)!)).toEqual({ v: 1, type: "evt", event: "tab.closed", data: { tabId: 7 } });
    conn.stop();
    expect(conn.sendEvent("tab.closed", { tabId: 7 })).toBe(false);
  });

  it("ignores old socket replies, events, commands, open and close callbacks", async () => {
    const onEvent = vi.fn();
    const { conn, requests, onDisconnect } = setup(undefined, { onEvent });
    const old = await authenticated(conn);
    conn.stop();
    const current = await authenticated(conn);
    const request = conn.request("status.get", {});
    const outbound = parseEnvelope(current.sent.at(-1)!);
    const id = outbound.type === "req" ? outbound.id : "";
    let settled = false;
    void request.then(() => { settled = true; });
    old.open();
    old.reply(makeOk(id, { obsolete: true }));
    old.reply({ v: 1, type: "evt", event: "status.changed", data: {} });
    old.reply({ v: 1, type: "req", id: "stale", method: "browser.click", params: {} });
    old.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(requests).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(conn.status().state).toBe("connected");
    current.reply(makeOk(id, { current: true }));
    await expect(request).resolves.toEqual({ current: true });
    expect(old.sent).toHaveLength(2);
  });

  it("does not open a socket after stop during asynchronous storage reads", async () => {
    let release!: (value: unknown) => void;
    const previous = FakeWs.last;
    const { conn } = setup(undefined, { storage: { get: (key) => key === "pairingToken" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(key === "clientId" ? "cli-1" : undefined), set: async () => {} } });
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    conn.stop();
    release("tok");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWs.last).toBe(previous);
    expect(conn.status().state).toBe("disconnected");
  });

  it("drops asynchronous browser results after stop even if close notification is delayed", async () => {
    let finish!: (value: unknown) => void;
    const { conn } = setup(undefined, { onRequest: () => new Promise((resolve) => { finish = resolve; }) });
    const ws = await authenticated(conn);
    ws.reply({ v: 1, type: "req", id: "running", method: "browser.wait", params: {} });
    ws.close = () => {}; // A close event need not be synchronous.
    conn.stop();
    finish({ done: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent.map(parseEnvelope).some((env) => env.type === "res" && env.id === "running")).toBe(false);
  });

  it("clears request deadlines on response and preserves structured server errors", async () => {
    const { conn } = setup();
    const ws = await authenticated(conn);
    const result = conn.request("operation.abort", {}).catch((error: unknown) => error);
    const req = parseEnvelope(ws.sent.at(-1)!);
    ws.reply(makeErr(req.type === "req" ? req.id : "", { code: "OPERATION_INVALID", message: "expired operation", retry: "never", details: { reason: "expired" } }));
    expect(await result).toMatchObject({ code: "OPERATION_INVALID", message: "expired operation", retry: "never", details: { reason: "expired" } });
    expect(vi.getTimerCount()).toBe(1); // Only the next heartbeat remains.
    conn.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects pending requests and reconnects after a synchronous send failure", async () => {
    const { conn, onDisconnect } = setup();
    const ws = await authenticated(conn);
    ws.send = () => { throw new Error("socket failed"); };
    await expect(conn.request("status.get", {})).rejects.toMatchObject({ code: "BROWSER_DISCONNECTED" });
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(ws.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWs.last).not.toBe(ws);
  });

  it("does not create duplicate sockets while storage is still loading", async () => {
    let release!: (value: unknown) => void;
    const get = vi.fn((key: string): Promise<unknown> => key === "pairingToken"
      ? new Promise((resolve) => { release = resolve; })
      : Promise.resolve(key === "clientId" ? "cli-1" : undefined));
    const { conn } = setup(undefined, { storage: { get, set: async () => {} } });
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    conn.ensure();
    conn.ensure();
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    release("tok");
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.status().state).toBe("connecting");
    conn.stop();
  });

});


describe("BridgeConnection mutual authentication", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("does not disclose a token or run browser commands for a squatting legacy server", async () => {
    const { conn, requests } = setup();
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.last;
    ws.open();
    const hello = parseEnvelope(ws.sent[0]!);
    expect(hello.type === "req" && hello.params).not.toHaveProperty("token");
    ws.reply(makeOk(hello.type === "req" ? hello.id : "", { selected: true }));
    ws.reply({ v: 1, type: "req", id: "attack", method: "browser.click", params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([]);
    expect(conn.status().state).toBe("auth_failed");
    expect(ws.readyState).toBe(3);
  });

  it("rejects an invalid server proof without sending a client proof", async () => {
    const { conn } = setup();
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.last;
    ws.open();
    const hello = parseEnvelope(ws.sent[0]!);
    ws.reply(makeOk(hello.type === "req" ? hello.id : "", { authVersion: 1, serverNonce: "11".repeat(32), serverProof: "00".repeat(32) }));
    await vi.waitFor(() => expect(conn.status().state).toBe("auth_failed"));
    expect(ws.sent).toHaveLength(1);
    expect(ws.readyState).toBe(3);
  });

  it("does not execute requests until the verified client proof is acknowledged", async () => {
    const { conn, requests } = setup();
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.last;
    ws.open();
    const hello = parseEnvelope(ws.sent[0]!);
    if (hello.type !== "req") throw new Error("Expected hello");
    const serverNonce = "22".repeat(32);
    ws.reply(makeOk(hello.id, { authVersion: 1, serverNonce, serverProof: nodeProof("server", hello.params, serverNonce) }));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));
    ws.reply({ v: 1, type: "req", id: "too-early", method: "browser.click", params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([]);
    expect(conn.status().state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.readyState).toBe(3);
  });

  it("rejects a valid server proof replayed for a fresh client nonce", async () => {
    const { conn } = setup();
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const old = FakeWs.last;
    old.open();
    const previous = parseEnvelope(old.sent[0]!);
    if (previous.type !== "req") throw new Error("Expected hello");
    const serverNonce = "22".repeat(32);
    const capturedProof = nodeProof("server", previous.params, serverNonce);
    conn.stop();
    conn.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWs.last;
    ws.open();
    const current = parseEnvelope(ws.sent[0]!);
    if (current.type !== "req") throw new Error("Expected hello");
    expect(current.params.clientNonce).not.toBe(previous.params.clientNonce);
    ws.reply(makeOk(current.id, { authVersion: 1, serverNonce, serverProof: capturedProof }));
    await vi.waitFor(() => expect(conn.status().state).toBe("auth_failed"));
    expect(ws.sent).toHaveLength(1);
  });

});

describe("management request deadlines", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it.each([["runtime.status", 60000], ["runtime.ensure", 120000], ["doctor.run", 120000], ["runtime.stop", 30000], ["profile.save", 30000], ["profile.delete", 30000]] as const)("allows %s its startup/management deadline", async (method, deadline) => {
    const { conn } = setup(); const ws = await authenticated(conn);
    const original = ws.send.bind(ws);
    ws.send = text => { original(text); const message = parseEnvelope(text); if (message.type === "req" && message.method === "heartbeat") ws.reply(makeOk(message.id, {})); };
    let outcome: unknown;
    const pending = conn.request(method, { profileId: "fixture" }).then(value => { outcome = value; }, error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(deadline - 1); expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await pending; expect(outcome).toMatchObject({ code: "TIMEOUT" }); conn.stop();
  });
  it("rejects a pending runtime startup immediately when its transport closes", async () => {
    const { conn } = setup(); const ws = await authenticated(conn);
    const pending = expect(conn.request("runtime.ensure", { profileId: "fixture" })).rejects.toMatchObject({ code: "BROWSER_DISCONNECTED" });
    ws.close(); await pending; conn.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
