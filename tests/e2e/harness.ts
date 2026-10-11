import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, connect } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once, EventEmitter } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { McpDriver, type ToolOutcome } from "./mcp-driver";

declare const chrome: any;
export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BIN = join(ROOT, "target/debug/browser-bridge");
const DIST = join(ROOT, "extension/dist");
type Envelope = { type: string; id?: string; method?: string; params?: any; result?: any; ok?: boolean };

async function killOwned(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try { await exited; } finally { clearTimeout(timer); }
}
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function tcpReady(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
  });
}

/** Test-only transparent transport relay. It observes commands and can withhold their replies. */
export class ExtensionRelay {
  private server?: WebSocketServer;
  private sockets = new Set<WebSocket>();
  private latest?: WebSocket;
  private events = new EventEmitter();
  private methods = new Map<string, string>();
  private heldMethods = new Set<string>();
  private held = new Map<string, Envelope>();
  readonly commands: Envelope[] = [];
  port = 0;

  constructor(private bridgePort: number) {}
  async start() {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(this.server, "listening");
    this.port = (this.server.address() as { port: number }).port;
    this.server.on("connection", (client, request) => {
      this.latest = client;
      const upstream = new WebSocket(`ws://127.0.0.1:${this.bridgePort}/extension`, {
        headers: { origin: request.headers.origin ?? "" },
      });
      this.sockets.add(client); this.sockets.add(upstream);
      const queued: string[] = [];
      client.on("message", (data) => {
        const text = data.toString();
        const message: Envelope = JSON.parse(text);
        const method = message.id && this.methods.get(message.id);
        if (message.type === "res" && method && this.heldMethods.has(method)) {
          this.held.set(message.id!, message);
          this.events.emit("held", message);
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else queued.push(text);
      });
      upstream.on("open", () => { for (const text of queued.splice(0)) upstream.send(text); });
      upstream.on("message", (data) => {
        const text = data.toString();
        const message: Envelope = JSON.parse(text);
        if (message.type === "req" && message.id && message.method) {
          this.commands.push(message); this.methods.set(message.id, message.method);
          this.events.emit("command", message);
        }
        if (client.readyState === WebSocket.OPEN) client.send(text);
      });
      const closeBoth = () => { client.terminate(); upstream.terminate(); this.sockets.delete(client); this.sockets.delete(upstream); };
      client.on("close", closeBoth); upstream.on("close", closeBoth);
      client.on("error", () => {}); upstream.on("error", closeBoth);
    });
    return this;
  }
  clearHolds() { this.heldMethods.clear(); this.held.clear(); }
  holdReplies(method: string) { this.heldMethods.add(method); }
  async nextCommand(method: string): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.events.off("command", listen); reject(new Error(`No command ${method}`)); }, 10_000);
      const listen = (message: Envelope) => {
        if (message.method !== method) return;
        clearTimeout(timer); this.events.off("command", listen); resolve(message);
      };
      this.events.on("command", listen);
    });
  }
  async waitHeld(id: string) {
    await expect.poll(() => this.held.has(id), { message: "browser response must reach the relay before cutting the bridge" }).toBe(true);
    return this.held.get(id)!;
  }
  async replay(request: Envelope) {
    if (this.latest?.readyState !== WebSocket.OPEN) throw new Error("No connected extension");
    this.held.delete(request.id!);
    this.heldMethods.add(request.method!);
    this.methods.set(request.id!, request.method!);
    this.latest.send(JSON.stringify(request));
    return this.waitHeld(request.id!);
  }
  async stop() {
    for (const socket of this.sockets) socket.terminate();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

export class World {
  fixture!: { base: string; alt: number };
  bridge!: { port: number; home: string; token: string };
  context!: BrowserContext;
  mcp!: McpDriver;
  relay!: ExtensionRelay;
  extensionId!: string;
  adminPage!: Page;
  manifest!: { options_page: string; side_panel: { default_path: string } };
  private dir!: string;
  private fixtureProcess?: ChildProcess;
  private bridgeProcess?: ChildProcess;
  private drivers: McpDriver[] = [];
  private output = "";

  async start() {
    this.dir = await mkdtemp(join(tmpdir(), "agent-browser-e2e-"));
    try {
      this.fixtureProcess = spawn(process.execPath, [join(ROOT, "tests/fixtures/server.mjs"), "--port", "0", "--alt-port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
      this.fixtureProcess.stderr!.on("data", (data) => { this.output += data; });
      const lines = createInterface({ input: this.fixtureProcess.stdout! });
      const [line] = await once(lines, "line");
      lines.close();
      const ready = JSON.parse(line);
      this.fixture = { base: `http://127.0.0.1:${ready.port}`, alt: ready.altPort };
      this.bridge = { port: await freePort(), home: join(this.dir, "home"), token: "" };
      await this.startBridge();
      this.bridge.token = JSON.parse(await readFile(join(this.bridge.home, "config.json"), "utf8")).token;
      this.relay = await new ExtensionRelay(this.bridge.port).start();
      this.context = await chromium.launchPersistentContext(join(this.dir, "profile"), {
        channel: "chromium", headless: true,
        args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      });
      const worker = this.context.serviceWorkers()[0] ?? await this.context.waitForEvent("serviceworker");
      this.extensionId = new URL(worker.url()).host;
      this.manifest = JSON.parse(await readFile(join(DIST, "manifest.json"), "utf8"));
      this.adminPage = await this.context.newPage();
      await this.adminPage.goto(`chrome-extension://${this.extensionId}/${this.manifest.options_page}`);
      await this.adminPage.evaluate(({ token, port }) => chrome.storage.local.set({ pairingToken: token, bridgeUrl: `ws://127.0.0.1:${port}/extension` }), { token: this.bridge.token, port: this.relay.port });
      await this.waitConnected();
      this.mcp = await this.newMcp();
      return this;
    } catch (error) { await this.stop(); throw error; }
  }
  async newMcp() {
    const driver = new McpDriver(BIN, this.bridge.home, this.bridge.port);
    this.drivers.push(driver);
    return driver.initialize();
  }
  async startBridge() {
    this.bridgeProcess = spawn(BIN, ["serve", "--port", String(this.bridge.port)], {
      env: { ...process.env, AGENT_BROWSER_HOME: this.bridge.home }, stdio: ["ignore", "pipe", "pipe"],
    });
    this.bridgeProcess.stdout!.on("data", (data) => { this.output += data; });
    this.bridgeProcess.stderr!.on("data", (data) => { this.output += data; });
    await expect.poll(() => tcpReady(this.bridge.port), { message: "isolated Linux bridge startup", timeout: 10_000 }).toBe(true);
  }
  async killBridge() { await killOwned(this.bridgeProcess); }
  async restartBridge() {
    await this.killBridge();
    await this.startBridge();
    await this.waitConnected();
    // The same MCP process may first discover its stale socket. Retry only this safe read.
    const listed = await this.mcp.call("browser_tabs", { action: "list" });
    if (!listed.ok) {
      expect(listed.error?.code).toBe("BROWSER_DISCONNECTED");
      expect((await this.mcp.call("browser_tabs", { action: "list" })).ok).toBe(true);
    }
  }
  async restartWorker() {
    const before = await this.context.serviceWorkers()[0].evaluate(() => performance.timeOrigin);
    const cdp = await this.context.newCDPSession(this.adminPage);
    let observedStopped = false;
    cdp.on("ServiceWorker.workerVersionUpdated", (event) => {
      if (event.versions.some((version) => version.scriptURL.includes(this.extensionId) && version.runningStatus === "stopped")) observedStopped = true;
    });
    try {
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      await expect.poll(() => observedStopped, { message: "CDP observes the extension worker stop" }).toBe(true);
      await this.waitConnected();
      // Chromium can reuse a targetId; Worker.close is not a reliable restart boundary.
      await expect.poll(async () => {
        try { return await this.context.serviceWorkers()[0].evaluate(() => performance.timeOrigin); }
        catch { return before; }
      }, { message: "a new worker execution context replaces the stopped one" }).not.toBe(before);
    } finally { await cdp.detach(); }
  }
  async waitConnected() {
    await expect.poll(async () => {
      try {
        const status = await this.adminPage.evaluate(() => chrome.runtime.sendMessage({ kind: "get-conn-status" }));
        if (status?.state !== "connected") return status?.state;
        // Check a round-trip too: a just-killed socket can still report its old local state.
        const live = await this.admin("status.get");
        return live.browsers.some((browser: any) => browser.selected && browser.connected) ? "connected" : "connecting";
      } catch { return "restarting"; }
    }, { timeout: 40_000, message: "extension connects to the isolated bridge" }).toBe("connected");
  }
  async admin(method: string, params: Record<string, unknown> = {}) {
    const response = await this.adminPage.evaluate(({ method, params }) => chrome.runtime.sendMessage({ kind: "bridge", method, params }), { method, params });
    if (!response?.ok) throw new Error(`Extension request ${method}: ${JSON.stringify(response)}`);
    return response.result;
  }
  async open(path: string) {
    const page = await this.context.newPage();
    await page.goto(`${this.fixture.base}/${path}`);
    await page.waitForLoadState("load");
    return page;
  }
  async tabId(page: Page) {
    const tab = await this.adminPage.evaluate(async (url) => (await chrome.tabs.query({})).find((tab: any) => tab.url === url), page.url());
    if (!tab?.id) throw new Error(`No Chrome tab for ${page.url()}`);
    return tab.id as number;
  }
  async attach(page: Page, driver = this.mcp) {
    const result = await driver.call("browser_tabs", { action: "attach", tabId: await this.tabId(page) });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.operationId!;
  }
  async ok(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const result = await this.mcp.call(name, args);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result;
  }
  async log() { return (await fetch(`${this.fixture.base}/__log`)).json(); }
  async stop() {
    // Cleanup is independent: a broken browser transport must not strand owned child processes.
    await Promise.allSettled([
      ...this.drivers.map((driver) => driver.stop()),
      this.context?.close(), this.relay?.stop(),
      killOwned(this.bridgeProcess), killOwned(this.fixtureProcess),
    ]);
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
}

export const startWorld = () => new World().start();
