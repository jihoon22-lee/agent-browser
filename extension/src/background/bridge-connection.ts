import { answerChallenge, authHello, AUTH_VERSION } from "../protocol/auth";
import { makeErr, makeEvt, makeOk, makeReq, parseEnvelope, ProtocolError, type Envelope, type Req, type Res } from "../protocol/envelope";

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
  /** Cancel browser work immediately when the current transport is lost or stopped. */
  onDisconnect?: () => void;
  /** This extension's manifest version and a reload hook: an unpacked extension loads from the
   * install folder, so reloading once after an update runs the new files. */
  extensionVersion?: string;
  reload?: () => void;
}

type Pending = { complete: (env: Res) => void; fail: (error: ProtocolError) => void };

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:4317/extension";
const HEARTBEAT_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 10_000;
const MANAGEMENT_TIMEOUT_MS: Record<string, number> = { "runtime.status": 60_000, "runtime.ensure": 120_000, "doctor.run": 120_000, "runtime.stop": 30_000, "profile.save": 30_000, "profile.delete": 30_000 };
const MAX_BACKOFF_MS = 30_000;
const PAIRING_POLL_MS = 3_000;

export class BridgeConnection {
  private ws?: WebSocket;
  private backoff = 1_000;
  private timers = new Set<number>();
  private pending = new Map<string, Pending>();
  private current: ConnStatus = { state: "disconnected" };
  private stopped = false;
  private halted = false; // auth failures wait for user action
  private connecting = false;
  private lifecycle = 0;
  private pairingSocket?: WebSocket;

  constructor(private deps: ConnDeps) {}

  status() { return this.current; }
  private setStatus(s: ConnStatus) { this.current = s; this.deps.onStatus(s); }

  start() {
    if (this.ws || this.connecting) this.stop();
    this.stopped = false;
    this.halted = false;
    this.schedule(0);
  }
  stop() {
    this.stopped = true;
    this.lifecycle += 1;
    this.connecting = false;
    this.clearTimers();
    this.pairingSocket?.close(); this.pairingSocket = undefined;
    const ws = this.ws;
    if (ws) this.closeSocket(ws);
    this.setStatus({ state: "disconnected" });
  }

  /** Called from alarms/startup: reconnect unless connected or waiting for re-pairing. */
  ensure() {
    if (!this.stopped && !this.halted && !this.ws && !this.connecting) this.schedule(0);
  }

  private clearTimers() { for (const t of this.timers) this.deps.clearTimer(t); this.timers.clear(); }
  private cancelTimer(id: number) { this.deps.clearTimer(id); this.timers.delete(id); }
  private later(fn: () => void, ms: number) {
    const id = this.deps.setTimer(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
    return id;
  }
  private schedule(ms: number) { this.clearTimers(); this.later(() => void this.connect(), ms); }

  private async connect() {
    if (this.stopped || this.halted || this.connecting || this.ws) return;
    this.connecting = true;
    const lifecycle = this.lifecycle;
    const valid = () => lifecycle === this.lifecycle && !this.stopped;
    try {
      const token = (await this.deps.storage.get("pairingToken")) as string | undefined;
      if (!valid()) return;
      const url = ((await this.deps.storage.get("bridgeUrl")) as string | undefined) ?? DEFAULT_BRIDGE_URL;
      if (!valid()) return;
      let clientId = (await this.deps.storage.get("clientId")) as string | undefined;
      if (!valid()) return;
      if (!clientId) { clientId = `cli-${crypto.randomUUID()}`; await this.deps.storage.set("clientId", clientId); }
      if (!valid()) return;
      if (!token) { this.setStatus({ state: "unpaired" }); this.requestPairing(url, clientId, lifecycle); return; }
      const repair = Boolean(await this.deps.storage.get("repairPending"));
      if (!valid()) return;
      this.setStatus({ state: "connecting" });
      const ws = new this.deps.WebSocketImpl(url);
      this.ws = ws;
      // Bound the entire connect/hello phase, including sockets that never open.
      const authDeadline = this.later(() => this.closeSocket(ws), RESPONSE_TIMEOUT_MS);
      ws.onopen = () => {
        if (this.ws !== ws || this.stopped) return;
        const helloParams = authHello(clientId!, repair);
        const hello = makeReq("auth.hello", helloParams);
        this.pending.set(hello.id, {
          fail: () => {},
          complete: (res) => {
            if (!res.ok) { this.authRejected(ws, res); return; }
            void answerChallenge(token, helloParams, res.result).then((proof) => {
              if (this.ws !== ws || this.stopped || ws.readyState !== 1) return;
              const prove = makeReq("auth.prove", { authVersion: AUTH_VERSION, proof });
              this.pending.set(prove.id, {
                fail: () => {},
                complete: (ack) => {
                  if (!ack.ok) { this.authRejected(ws, ack); return; }
                  if ((ack.result as { authVersion?: number } | undefined)?.authVersion !== AUTH_VERSION) {
                    this.authFailed(ws, "Bridge did not acknowledge mutual authentication v1");
                    return;
                  }
                  this.cancelTimer(authDeadline);
                  this.backoff = 1_000;
                  if (repair) void this.deps.storage.set("repairPending", false);
                  this.setStatus({ state: "connected" });
                  this.startHeartbeat(ws);
                  void this.reloadIfOutdated((ack.result as { serverVersion?: unknown } | undefined)?.serverVersion);
                },
              });
              this.send(ws, prove);
            }).catch((error: unknown) => {
              this.authFailed(ws, error instanceof ProtocolError ? error.message : "Bridge authentication verification failed");
            });
          },
        });
        this.send(ws, hello);
      };
      ws.onmessage = (e) => void this.onMessage(ws, String(e.data));
      ws.onclose = () => this.onClose(ws);
      ws.onerror = () => this.closeSocket(ws);
    } catch {
      // Configuration and constructor errors must not strand the reconnect loop.
      if (valid()) this.retry();
    } finally {
      if (lifecycle === this.lifecycle) this.connecting = false;
    }
  }

  /** Without a token, ask the Bridge for one. It answers only while the installer has opened a
   * short pairing window, and only to this extension's fixed ID; otherwise retry quietly. */
  private requestPairing(url: string, clientId: string, lifecycle: number) {
    if (this.pairingSocket) return;
    const ws = new this.deps.WebSocketImpl(url);
    this.pairingSocket = ws;
    let settled = false;
    const finish = (paired: boolean) => {
      if (settled) return;
      settled = true; this.pairingSocket = undefined; this.cancelTimer(deadline);
      if (lifecycle !== this.lifecycle || this.stopped) return;
      this.schedule(paired ? 0 : PAIRING_POLL_MS);
    };
    const deadline = this.later(() => { ws.close(); finish(false); }, RESPONSE_TIMEOUT_MS);
    ws.onopen = () => { try { ws.send(JSON.stringify(makeReq("pair.request", { clientId }))); } catch { ws.close(); } };
    ws.onmessage = (event) => {
      let env: Envelope | undefined;
      try { env = parseEnvelope(String(event.data)); } catch { env = undefined; }
      const token = env?.type === "res" && env.ok ? (env.result as { token?: unknown } | undefined)?.token : undefined;
      // Detach onclose first: a synchronous close event must not turn a granted token into a retry.
      ws.onclose = null; ws.close();
      if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) { finish(false); return; }
      void (async () => {
        await this.deps.storage.set("repairPending", true);
        await this.deps.storage.set("pairingToken", token);
        finish(true);
      })();
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => finish(false);
  }

  private async reloadIfOutdated(serverVersion: unknown) {
    const own = this.deps.extensionVersion, reload = this.deps.reload;
    if (typeof serverVersion !== "string" || !own || !reload || compareVersions(serverVersion, own) <= 0) return;
    if ((await this.deps.storage.get("reloadedForBridge")) === serverVersion) return;
    await this.deps.storage.set("reloadedForBridge", serverVersion);
    reload();
  }

  private authRejected(ws: WebSocket, response: Res) {
    if (this.ws !== ws) return;
    const code = response.error?.code;
    this.halted = code === "AUTH_FAILED" || code === "NOT_PAIRED";
    this.setStatus({ state: code === "NOT_PAIRED" ? "not_paired" : code === "AUTH_FAILED" ? "auth_failed" : "disconnected", detail: response.error?.message });
    this.closeSocket(ws);
  }

  private authFailed(ws: WebSocket, detail: string) {
    if (this.ws !== ws) return;
    this.halted = true;
    this.setStatus({ state: "auth_failed", detail });
    this.closeSocket(ws);
  }

  private send(ws: WebSocket, env: Envelope): boolean {
    if (this.ws !== ws || this.stopped || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(env)); return true; }
    catch { this.closeSocket(ws); return false; }
  }

  private startHeartbeat(ws: WebSocket) {
    const beat = () => {
      if (this.ws !== ws || ws.readyState !== 1) return;
      const req = makeReq("heartbeat", {});
      const deadline = this.later(() => this.closeSocket(ws), RESPONSE_TIMEOUT_MS);
      this.pending.set(req.id, {
        fail: () => {},
        complete: (res) => {
          this.cancelTimer(deadline);
          if (res.ok) this.later(beat, HEARTBEAT_MS);
          else this.closeSocket(ws);
        },
      });
      this.send(ws, req);
    };
    this.later(beat, HEARTBEAT_MS);
  }

  private closeSocket(ws: WebSocket) {
    if (this.ws !== ws) return;
    // Detach and reject before close(): a browser may deliver onclose much later.
    this.onClose(ws);
    ws.close();
  }

  private onClose(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.ws = undefined;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.clearTimers();
    for (const request of pending) request.fail(new ProtocolError("BROWSER_DISCONNECTED", "Bridge connection closed", "safe"));
    this.deps.onDisconnect?.();
    if (!this.stopped && !this.halted) this.retry();
  }

  private retry() {
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.setStatus({ state: "disconnected", retryInMs: wait });
    this.schedule(wait);
  }

  private async onMessage(ws: WebSocket, text: string) {
    // Even responses must belong to the current socket. A stale socket cannot
    // complete a new socket's pending request or resurrect an old handshake.
    if (this.ws !== ws || this.stopped || ws.readyState !== 1) return;
    let env: Envelope;
    try { env = parseEnvelope(text); } catch { return; }
    if (env.type === "res") { const request = this.pending.get(env.id); this.pending.delete(env.id); request?.complete(env); return; }
    if (this.current.state !== "connected") {
      if (env.type === "req") this.send(ws, makeErr(env.id, { code: "AUTH_REQUIRED", message: "auth.hello has not completed", retry: "never" }));
      return;
    }
    if (env.type === "evt") { this.deps.onEvent?.(env.event, env.data); return; }
    try {
      const result = await this.deps.onRequest(env);
      this.send(ws, makeOk(env.id, result));
    } catch (e) {
      const err = e instanceof ProtocolError ? e.toRpc() : { code: "INTERNAL" as const, message: String(e), retry: "never" as const };
      this.send(ws, makeErr(env.id, err));
    }
  }

  /** Events are best-effort and are never queued across reconnects. */
  sendEvent(event: string, data: unknown): boolean {
    const ws = this.ws;
    return !!ws && this.current.state === "connected" && this.send(ws, makeEvt(event, data));
  }

  /** Request to serve (status.get, operation.abort, browser.use). */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.current.state !== "connected" || this.stopped) {
      return Promise.reject(new ProtocolError("BROWSER_DISCONNECTED", "Bridge is not connected", "safe"));
    }
    const req = makeReq(method, params);
    return new Promise((resolve, reject) => {
      const deadline = this.later(() => {
        this.pending.delete(req.id);
        reject(new ProtocolError("TIMEOUT", `Bridge did not answer ${method}`, method === "status.get" ? "safe" : "unsafe"));
      }, MANAGEMENT_TIMEOUT_MS[method] ?? RESPONSE_TIMEOUT_MS);
      this.pending.set(req.id, {
        fail: (error) => { this.cancelTimer(deadline); reject(error); },
        complete: (res) => {
          this.cancelTimer(deadline);
          if (res.ok) resolve(res.result);
          else if (res.error) reject(new ProtocolError(res.error.code, res.error.message, res.error.retry, res.error.details));
          else reject(new ProtocolError("INTERNAL", "Bridge returned an error without details"));
        },
      });
      this.send(ws, req);
    });
  }
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(/[-+]/)[0]!.split(".").slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
