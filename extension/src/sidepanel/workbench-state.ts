// View data stays keyed by server session/message/part IDs; it is never a second agent runtime.
export type Data = Record<string, any>;
export type UiMessage = { info: Data; parts: Data[] };
export type WorkbenchState = { messages: Record<string, UiMessage[]>; questions: Data[]; permissions: Data[]; statuses: Record<string, Data>; errors: Record<string, string> };
export const initialWorkbench: WorkbenchState = { messages: {}, questions: [], permissions: [], statuses: {}, errors: {} };
const byId = <T extends Data>(items: T[]) => [...new Map(items.map(item => [item.id, item])).values()];
/** Whether a message fetched from the server is exactly what the view already holds. */
export function sameMessage(held: UiMessage | undefined, fetched: UiMessage): boolean {
  if (!held) return false;
  const fetchedParts = byId(fetched.parts ?? []);
  // Fast-path structural checks avoid serializing multi-MB base64 attachments when messages obviously differ.
  if (held.info?.id !== fetched.info?.id) return false;
  if (held.info?.time?.completed !== fetched.info?.time?.completed) return false;
  if (held.info?.finish !== fetched.info?.finish) return false;
  if (Boolean(held.info?.error) !== Boolean(fetched.info?.error)) return false;
  if (held.parts.length !== fetchedParts.length) return false;
  for (let i = 0; i < held.parts.length; i++) {
    const a = held.parts[i]!, b = fetchedParts[i]!;
    if (a.id !== b.id || a.type !== b.type) return false;
    if (typeof a.text === "string" || typeof b.text === "string") {
      if (a.text !== b.text) return false;
    }
    if (a.state?.status !== b.state?.status) return false;
    if (typeof a.state?.output === "string" && typeof b.state?.output === "string" && a.state.output.length !== b.state.output.length) return false;
  }
  return JSON.stringify(held) === JSON.stringify({ ...fetched, parts: fetchedParts });
}
export function workbenchReducer(state: WorkbenchState, action: Data): WorkbenchState {
  if (action.type === "events") {
    let next = state;
    for (const event of action.events as Data[]) next = workbenchReducer(next, { type: "event", event });
    return next;
  }
  if (action.type === "reset") return initialWorkbench;
  if (action.type === "messages") {
    // Snapshots are refetched while a response runs; keep unchanged messages identical so memoized cards skip rendering.
    const previous = new Map((state.messages[action.sessionID] ?? []).map(message => [message.info.id, message]));
    const next = action.messages.map((m: UiMessage) => {
      const message = { ...m, parts: byId(m.parts) }, old = previous.get(m.info?.id);
      return old && sameMessage(old, message) ? old : message;
    });
    return { ...state, messages: { ...state.messages, [action.sessionID]: next } };
  }
  if (action.type === "forget") {
    const messages = { ...state.messages }, statuses = { ...state.statuses }, errors = { ...state.errors };
    delete messages[action.sessionID];
    delete statuses[action.sessionID];
    delete errors[action.sessionID];
    return {
      ...state,
      messages,
      statuses,
      errors,
      questions: state.questions.filter(q => q.sessionID !== action.sessionID),
      permissions: state.permissions.filter(p => p.sessionID !== action.sessionID),
    };
  }
  if (action.type === "pending") return { ...state, questions: byId(action.questions), permissions: byId(action.permissions) };
  if (action.type === "statuses") return { ...state, statuses: action.statuses };
  if (action.type === "clear-error") {
    const errors = { ...state.errors };
    if (action.sessionID) delete errors[action.sessionID];
    delete errors.global;
    return { ...state, errors };
  }
  if (action.type !== "event") return state;
  const event = action.event, p = event.properties ?? {};
  // Replayed events are dropped by event ID in the stream client (OpenCodeV1Client.events), not here.
  const next = state;
  if (event.type === "session.status") {
    const errors = { ...state.errors }; if (p.status?.type === "busy") delete errors[p.sessionID];
    return { ...next, errors, statuses: { ...state.statuses, [p.sessionID]: p.status } };
  }
  if (event.type === "session.idle") return { ...next, statuses: { ...state.statuses, [p.sessionID]: { type: "idle" } } };
  if (event.type === "session.error") return { ...next, errors: { ...state.errors, [p.sessionID ?? "global"]: String(p.error?.data?.message ?? p.error?.message ?? p.error?.name ?? "OpenCode 작업에 실패했습니다.").slice(0, 1000) } };
  if (event.type === "question.asked") return { ...next, questions: byId([...state.questions, p]) };
  if (event.type === "permission.asked") return { ...next, permissions: byId([...state.permissions, p]) };
  if (["question.replied", "question.rejected"].includes(event.type)) return { ...next, questions: state.questions.filter(q => q.id !== p.requestID) };
  if (event.type === "permission.replied") return { ...next, permissions: state.permissions.filter(q => q.id !== p.requestID) };
  if (!["message.updated", "message.removed", "message.part.updated", "message.part.removed", "message.part.delta"].includes(event.type)) return next;
  const sessionID = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
  const messageID = p.messageID ?? p.info?.id ?? p.part?.messageID;
  if (!sessionID || !messageID) return next;
  const list = [...(state.messages[sessionID] ?? [])];
  if (event.type === "message.removed") return { ...next, messages: { ...state.messages, [sessionID]: list.filter(m => m.info.id !== messageID) } };
  if (event.type === "message.updated" && (!p.info || typeof p.info !== "object" || typeof p.info.id !== "string")) return next;
  let index = list.findIndex(m => m.info.id === messageID);
  if (index < 0) { index = list.length; list.push({ info: { id: messageID, sessionID, role: "assistant", time: { created: 0 } }, parts: [] }); }
  const message = { ...list[index]!, parts: [...list[index]!.parts] };
  if (event.type === "message.updated") message.info = p.info;
  if (event.type === "message.part.updated" && p.part && typeof p.part === "object") message.parts = byId([...message.parts, p.part]);
  if (event.type === "message.part.removed") message.parts = message.parts.filter(part => part.id !== p.partID);
  if (event.type === "message.part.delta") {
    const i = message.parts.findIndex(part => part.id === p.partID);
    const part = i >= 0 ? { ...message.parts[i]! } : { id: p.partID, messageID, sessionID, type: p.part?.type ?? "text", text: "" };
    // Only text fields are appended; arbitrary event properties cannot rewrite object prototypes.
    if (p.field === "text" && typeof p.delta === "string") part.text = String(part.text ?? "") + p.delta;
    if (i >= 0) message.parts[i] = part; else message.parts.push(part);
  }
  list[index] = message;
  return { ...next, messages: { ...state.messages, [sessionID]: list } };
}
/** The configured server is authoritative. Never supplement it from an external model catalogue. */
export function availableModels(catalog: Data): Data[] {
  const connected = new Set(catalog.connected ?? []);
  return (catalog.all ?? []).filter((provider: Data) => connected.has(provider.id)).flatMap((provider: Data) => Object.entries(provider.models ?? {}).map(([id, model]) => ({ ...(model as Data), id: (model as Data).id ?? id, providerID: provider.id, providerName: provider.name ?? provider.id }))).filter((model: Data) => model.status !== "deprecated");
}
export function toolOutcome(output: unknown): Data | null {
  try {
    const value = typeof output === "string" ? JSON.parse(output) : output;
    if (value && typeof value === "object" && Array.isArray((value as Data).content)) {
      for (const part of (value as Data).content) if (part.type === "text") { const parsed = toolOutcome(part.text); if (parsed) return parsed; }
    }
    return value && typeof value === "object" && typeof (value as Data).ok === "boolean" && typeof (value as Data).tool === "string" ? value as Data : null;
  } catch { return null; }
}
export function operationBindings(messages: UiMessage[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const message of messages) for (const part of message.parts) {
    if (part.type !== "tool" || !["browser_tabs", "browser_browser_tabs"].includes(part.tool) || part.state?.status !== "completed" || part.state?.input?.action !== "attach") continue;
    const outcome = toolOutcome(part.state.output);
    if (outcome?.ok === true && outcome.tool === "browser_tabs" && typeof outcome.operationId === "string") bindings[outcome.operationId] = message.info.sessionID;
  }
  return bindings;
}
export const shouldSubmit = (event: { key: string; isComposing?: boolean; shiftKey?: boolean; keyCode?: number }) => event.key === "Enter" && !event.isComposing && !event.shiftKey && event.keyCode !== 229;
export function dataUrlBytes(url: unknown): number | null {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (meta.includes(";base64")) {
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(decodeURIComponent(payload)).length;
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export async function filePart(file: File): Promise<Data> {
  if (file.size > 10 * 1024 * 1024) throw new Error("첨부 파일은 각각 10MB 이하로 선택하세요.");
  const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("첨부 파일을 읽지 못했습니다.")); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); });
  return { type: "file", mime: file.type || "application/octet-stream", filename: file.name, url };
}
export const textFilePart = (name: string, text: string) => filePart(new File([text], name, { type: "text/plain" }));
export async function respondOnce(inflight: Set<string>, id: string, list: () => Promise<unknown[]>, submit: () => Promise<unknown>): Promise<boolean> {
  if (inflight.has(id)) return false;
  inflight.add(id);
  try { if (!(await list()).some(value => (value as Data).id === id)) return false; await submit(); return true; }
  catch (error) { if (error && typeof error === "object" && "status" in error && error.status === 404) return false; throw error; }
  finally { inflight.delete(id); }
}
/** A failed Bridge request with its protocol code and retry class, so callers classify it without reading the English text. */
export class BridgeRequestError extends Error {
  constructor(message: string, readonly code?: string, readonly retry?: string) { super(message); this.name = "BridgeRequestError"; }
}
export const codeOf = (error: unknown): string | undefined => error instanceof BridgeRequestError ? error.code : undefined;
export async function bridgeRequest<T = any>(method: string, params: Data = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ kind: "bridge", method, params });
  if (!response?.ok) { const error = response?.error; throw new BridgeRequestError(error?.message ?? error?.code ?? "Bridge 응답을 받지 못했습니다.", typeof error?.code === "string" ? error.code : undefined, typeof error?.retry === "string" ? error.retry : undefined); }
  return response.result;
}
export function download(name: string, content: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type: mime })), link = document.createElement("a");
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const csv = (rows: unknown[][]) => rows.map(row => row.map(value => '"' + String(value ?? "").replaceAll('"', '""') + '"').join(",")).join("\r\n");

export function activeMention(text: string): string | undefined {
  const match = /(?:^|\s)@(?:"([^"]*)"?|([^\s]*))$/.exec(text);
  return match ? match[1] ?? match[2] : undefined;
}
export function replaceMention(text: string, replacement: string): string { return text.replace(/@(?:"[^"]*"?|[^\s]*)$/, replacement); }
