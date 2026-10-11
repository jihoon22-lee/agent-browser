import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

export type ToolOutcome = {
  ok: boolean;
  operationId: string | null;
  delivered: boolean;
  executed: "yes" | "no" | "unknown";
  verified: Record<string, unknown> | null;
  data: any;
  error?: { code: string; message: string; retry: string };
};
export type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Actual rmcp stdio transport; every stdout line, including notifications, must be JSON-RPC. */
export class McpDriver {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: unknown[] = [];
  readonly invalidStdout: string[] = [];
  stderr = "";
  private next = 0;
  private pending = new Map<number, Pending>();
  private failure?: Error;

  constructor(exe: string, home: string, port: number) {
    this.child = spawn(exe, ["mcp"], {
      env: { ...process.env, AGENT_BROWSER_HOME: home, AGENT_BROWSER_PORT: String(port), AGENT_BROWSER_LOG: "debug" },
      stdio: "pipe",
    });
    this.child.stderr.on("data", (data) => { this.stderr += data.toString(); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
        if (message?.jsonrpc !== "2.0") throw new Error("missing JSON-RPC version");
      } catch {
        this.invalidStdout.push(line);
        this.fail(new Error(`MCP stdout is not JSON-RPC: ${line}`));
        return;
      }
      this.stdout.push(message);
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => this.fail(new Error(`MCP exited (${code ?? signal}): ${this.stderr}`)));
  }

  private fail(error: Error) {
    this.failure = error;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-browser-e2e", version: "1" },
    });
    if (result.serverInfo?.name !== "agent-browser") throw new Error("Unexpected MCP server");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return this;
  }

  request(method: string, params: unknown = {}): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} response timed out: ${this.stderr}`));
      }, 70_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  callRaw(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.request("tools/call", { name, arguments: args });
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const result = await this.callRaw(name, args);
    const text = result.content.find((part) => part.type === "text")?.text;
    if (!text) throw new Error(`Missing ToolOutcome for ${name}`);
    return JSON.parse(text);
  }

  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
}
