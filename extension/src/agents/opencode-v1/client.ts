import type { OpenCodeEvent } from "./types";

export type Connection = { baseUrl: string; directory: string; username?: string; password?: string };
type Query = Record<string, string | number | boolean | undefined>;
type RequestOptions = { query?: Query; body?: unknown; signal?: AbortSignal; timeoutMs?: number };
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OpenCodeApiError extends Error {
  constructor(readonly status: number, readonly details: unknown) {
    const data = details && typeof details === "object" ? details as Record<string, unknown> : {};
    const nested = data.data && typeof data.data === "object" ? data.data as Record<string, unknown> : {};
    const text = typeof data.message === "string" ? data.message : typeof nested.message === "string" ? nested.message : typeof details === "string" ? details : "OpenCode 요청을 완료하지 못했습니다.";
    super(`OpenCode HTTP ${status}: ${text.slice(0, 1000)}`);
    this.name = "OpenCodeApiError";
  }
}

function basic(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "Basic " + btoa(binary);
}

function aborted(signal?: AbortSignal) { return signal?.aborted === true; }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Parse SSE incrementally; no replay is assumed. State must be re-fetched on reconnect. */
export async function* parseSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let buffer = "", data: string[] = [], id: string | undefined, eventBytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!aborted(signal)) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length + eventBytes > 16 * 1024 * 1024) throw new Error("OpenCode 이벤트가 크기 제한을 초과했습니다.");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) {
            const parsed: unknown = JSON.parse(data.join("\n"));
            if (parsed && typeof parsed === "object" && typeof (parsed as OpenCodeEvent).type === "string") {
              const event = parsed as OpenCodeEvent;
              if (!event.properties || typeof event.properties !== "object" || Array.isArray(event.properties)) throw new Error("OpenCode 이벤트 형식이 올바르지 않습니다.");
              yield { ...event, ...(event.id === undefined && id ? { id } : {}) };
            }
          }
          data = []; id = undefined; eventBytes = 0;
        } else if (line.startsWith("data:")) {
          const next = line.slice(5).replace(/^ /, ""); data.push(next); eventBytes += next.length;
        } else if (line.startsWith("id:")) id = line.slice(3).replace(/^ /, "");
      }
      if (done) break; // An unterminated event is incomplete and must not be dispatched.
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Thin adapter for the stored 1.18.29 v1 contract. Mutations are never retried. */
export class OpenCodeV1Client {
  readonly directory: string;
  readonly baseUrl: string;
  private readonly authorization?: string;
  constructor(connection: Connection, private readonly fetcher: Fetch = (input, init) => globalThis.fetch(input, init), private readonly options: { retryDelayMs?: number } = {}) {
    const url = new URL(connection.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("OpenCode 서버 주소는 인증정보가 없는 HTTP(S) origin이어야 합니다.");
    this.baseUrl = url.origin;
    this.directory = connection.directory;
    if (connection.password) this.authorization = basic(connection.username || "opencode", connection.password);
  }
  private url(path: string, query: Query = {}): string {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("?") || path.includes("#")) throw new Error("상대 OpenCode v1 API 경로만 사용할 수 있습니다.");
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl || url.pathname.startsWith("/api/") || url.pathname === "/api" || url.pathname.startsWith("/tui/") || url.pathname.includes("/share")) throw new Error("지원하지 않는 OpenCode API 경로입니다.");
    if (!path.startsWith("/global/") && this.directory) url.searchParams.set("directory", this.directory);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    return url.href;
  }
  private headers(stream = false): Headers {
    const headers = new Headers({ Accept: stream ? "text/event-stream" : "application/json" });
    if (this.authorization) headers.set("Authorization", this.authorization);
    return headers;
  }
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query), headers = this.headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.fetcher(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal, redirect: "error", cache: "no-store", credentials: "omit" });
    const text = await response.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : undefined; }
    catch { if (response.ok) throw new Error("OpenCode 응답이 JSON이 아닙니다."); value = text; }
    if (!response.ok) throw new OpenCodeApiError(response.status, value);
    return value as T;
  }
  get<T = unknown>(path: string, query?: Query) { return this.request<T>("GET", path, { query }); }
  post<T = unknown>(path: string, body?: unknown, query?: Query) { return this.request<T>("POST", path, { body, query }); }
  patch<T = unknown>(path: string, body?: unknown, query?: Query) { return this.request<T>("PATCH", path, { body, query }); }
  delete<T = unknown>(path: string, query?: Query) { return this.request<T>("DELETE", path, { query }); }
  async findFiles(query: string, limit = 12): Promise<string[]> {
    const matches = await this.get<string[]>("/find/file", { query, limit });
    if (matches.length) return matches.slice(0, limit);
    // Native 1.18.29 can return an empty index while /file still lists real files.
    // Offer directory-prefix navigation using that same server, without reading local OS paths.
    const normalized = query.replaceAll("\\", "/"), slash = normalized.lastIndexOf("/");
    const directory = slash < 0 ? "" : normalized.slice(0, slash + 1), term = normalized.slice(slash + 1).toLocaleLowerCase();
    const entries = await this.get<Array<{ name: string; path: string; type: string; ignored?: boolean }>>("/file", { path: directory });
    return entries.filter(entry => !entry.ignored && entry.name.toLocaleLowerCase().includes(term))
      .map(entry => entry.path.replaceAll("\\", "/").replace(/\/$/, "") + (entry.type === "directory" ? "/" : ""))
      .sort((a, b) => a.localeCompare(b, "ko")).slice(0, limit);
  }
  async events(onEvent: (event: OpenCodeEvent) => void, onConnection: (connected: boolean) => void, signal: AbortSignal): Promise<void> {
    const seen = new Set<string>();
    let retry = 0;
    while (!signal.aborted) {
      try {
        const response = await this.fetcher(this.url("/event"), { headers: this.headers(true), signal, redirect: "error", cache: "no-store", credentials: "omit" });
        if (!response.ok) throw new OpenCodeApiError(response.status, await response.text());
        if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("OpenCode 이벤트 스트림을 열 수 없습니다.");
        onConnection(true); retry = 0;
        for await (const event of parseSse(response.body, signal)) {
          if (signal.aborted) break;
          if (event.id && seen.has(event.id)) continue;
          if (event.id) { seen.add(event.id); if (seen.size > 2048) seen.delete(seen.values().next().value!); }
          onEvent(event);
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof OpenCodeApiError && [401, 403, 404].includes(error.status)) { onConnection(false); throw error; }
      }
      if (!signal.aborted) {
        onConnection(false);
        await delay(this.options.retryDelayMs ?? Math.min(5000, 500 * 2 ** retry++), signal);
      }
    }
  }
}
