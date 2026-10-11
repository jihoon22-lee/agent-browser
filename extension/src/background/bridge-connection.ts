import { makeErr, makeOk, makeReq, parseEnvelope, ProtocolError, type Envelope, type Req } from "../protocol/envelope";

export type ConnStatus = {
  state: "unpaired" | "connecting" | "connected" | "auth_failed" | "not_paired" | "disconnected";
  detail?: string;
  retryInMs?: number;
};
export interface KeyValueStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
export interface ConnDeps {
  WebSocketImpl: typeof WebSocket;
  storage: KeyValueStore;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  onRequest: (req: Req) => Promise<unknown>;
  onStatus: (s: ConnStatus) => void;
  onEvent?: (event: string, data: unknown) => void;
}

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:4317/extension";
const HEARTBEAT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class BridgeConnection {
  private ws?: WebSocket;
  private backoff = 1_000;
  private timers = new Set<number>();
  private pending = new Map<string, (env: Envelope) => void>();
  private current: ConnStatus = { state: "disconnected" };
  private stopped = false;
  private halted = false; // auth failures wait for user action

  constructor(private deps: ConnDeps) {}

  status() { return this.current; }
  private setStatus(s: ConnStatus) { this.current = s; this.deps.onStatus(s); }

  start() { this.stopped = false; this.halted = false; this.schedule(0); }
  stop() { this.stopped = true; this.clearTimers(); this.ws?.close(); }

  /** Called from alarms/startup: reconnect unless connected or waiting for re-pairing. */
  ensure() { if (!this.stopped && !this.halted && (!this.ws || this.ws.readyState > 1)) this.schedule(0); }

  private clearTimers() { for (const t of this.timers) this.deps.clearTimer(t); this.timers.clear(); }
  private later(fn: () => void, ms: number) {
    const id = this.deps.setTimer(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
    return id;
  }
  private schedule(ms: number) { this.clearTimers(); this.later(() => void this.connect(), ms); }

  private async connect() {
    const token = (await this.deps.storage.get("pairingToken")) as string | undefined;
    if (!token) { this.setStatus({ state: "unpaired" }); return; }
    const url = ((await this.deps.storage.get("bridgeUrl")) as string | undefined) ?? DEFAULT_BRIDGE_URL;
    let clientId = (await this.deps.storage.get("clientId")) as string | undefined;
    if (!clientId) { clientId = `cli-${crypto.randomUUID()}`; await this.deps.storage.set("clientId", clientId); }
    const repair = Boolean(await this.deps.storage.get("repairPending"));
    this.setStatus({ state: "connecting" });
    const ws = new this.deps.WebSocketImpl(url);
    this.ws = ws;
    ws.onopen = () => {
      const hello = makeReq("auth.hello", { role: "extension", token, clientId, clientVersion: "0.1.0", repair });
      this.pending.set(hello.id, (res) => {
        if (res.type === "res" && res.ok) {
          this.backoff = 1_000;
          if (repair) void this.deps.storage.set("repairPending", false);
          this.setStatus({ state: "connected" });
          this.startHeartbeat(ws);
        } else if (res.type === "res") {
          const code = res.error?.code;
          this.halted = code === "AUTH_FAILED" || code === "NOT_PAIRED";
          this.setStatus({ state: code === "NOT_PAIRED" ? "not_paired" : code === "AUTH_FAILED" ? "auth_failed" : "disconnected", detail: res.error?.message });
        }
      });
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (e) => void this.onMessage(ws, String(e.data));
    ws.onclose = () => this.onClose(ws);
    ws.onerror = () => { /* onclose follows */ };
  }

  private startHeartbeat(ws: WebSocket) {
    const beat = () => {
      if (this.ws !== ws || ws.readyState !== 1) return;
      const req = makeReq("heartbeat", {});
      const deadline = this.later(() => ws.close(), HEARTBEAT_TIMEOUT_MS);
      this.pending.set(req.id, () => { this.deps.clearTimer(deadline); this.timers.delete(deadline); this.later(beat, HEARTBEAT_MS); });
      ws.send(JSON.stringify(req));
    };
    this.later(beat, HEARTBEAT_MS);
  }

  private onClose(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.pending.clear();
    this.clearTimers();
    if (this.stopped || this.halted) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.setStatus({ state: "disconnected", retryInMs: wait });
    this.schedule(wait);
  }

  private async onMessage(ws: WebSocket, text: string) {
    let env: Envelope;
    try { env = parseEnvelope(text); } catch { return; }
    if (env.type === "res") { const cb = this.pending.get(env.id); this.pending.delete(env.id); cb?.(env); return; }
    // Nothing the server sends is acted on until our auth.hello was acknowledged on this socket.
    if (this.ws !== ws || this.current.state !== "connected") {
      if (env.type === "req" && ws.readyState === 1) {
        ws.send(JSON.stringify(makeErr(env.id, { code: "AUTH_REQUIRED", message: "auth.hello has not completed", retry: "never" })));
      }
      return;
    }
    if (env.type === "evt") { this.deps.onEvent?.(env.event, env.data); return; }
    try {
      const result = await this.deps.onRequest(env);
      if (ws.readyState === 1) ws.send(JSON.stringify(makeOk(env.id, result)));
    } catch (e) {
      const err = e instanceof ProtocolError ? e.toRpc() : { code: "INTERNAL" as const, message: String(e), retry: "never" as const };
      if (ws.readyState === 1) ws.send(JSON.stringify(makeErr(env.id, err)));
    }
  }

  /** Request to serve (status.get, operation.abort, browser.use). */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.current.state !== "connected") {
      return Promise.reject(new ProtocolError("BROWSER_DISCONNECTED", "Bridge is not connected", "safe"));
    }
    const req = makeReq(method, params);
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, (res) => res.type === "res" && res.ok ? resolve(res.result) : reject(res.type === "res" ? res.error : res));
      ws.send(JSON.stringify(req));
    });
  }
}
