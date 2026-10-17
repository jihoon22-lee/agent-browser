import type { ConnStatus } from "../background/bridge-connection";

export type Operation = { id: string; tabs: number[]; currentTab: number; state: string; clientId?: string; currentTabClosed?: boolean; paused?: boolean };
export type BrowserInfo = { clientId: string; connected: boolean; selected: boolean };
export type TimelineEntry = { atMs: number; operationId?: string | null; tool: string; summary: string; outcome: string };
export type PanelState = { conn: ConnStatus; operation: Operation | null; browsers: BrowserInfo[]; timeline: TimelineEntry[]; stopping: boolean; stopped: boolean; error: string | null };
export const initialPanelState: PanelState = { conn: { state: "disconnected" }, operation: null, browsers: [], timeline: [], stopping: false, stopped: false, error: null };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";
const isOperation = (value: unknown): value is Operation => object(value) && typeof value.id === "string" && Array.isArray(value.tabs) && value.tabs.every(Number.isInteger) && typeof value.currentTab === "number" && typeof value.state === "string";
const isBrowser = (value: unknown): value is BrowserInfo => object(value) && typeof value.clientId === "string" && typeof value.connected === "boolean" && typeof value.selected === "boolean";
const isEntry = (value: unknown): value is TimelineEntry => object(value) && typeof value.atMs === "number" && typeof value.tool === "string" && typeof value.summary === "string" && typeof value.outcome === "string";

export function reduceStatus(state: PanelState, message: unknown): PanelState {
  if (!object(message)) return state;
  if (message.kind === "conn-status" && object(message.status) && ["unpaired", "connecting", "connected", "auth_failed", "not_paired", "disconnected"].includes(String(message.status.state))) {
    const conn = message.status as ConnStatus;
    return { ...state, conn, ...(conn.state !== "connected" ? { operation: null, browsers: [], stopping: false, stopped: false } : { error: null }) };
  }
  if (message.kind === "bridge-event" && message.event === "status.changed" && object(message.data)) {
    const data = message.data;
    if (!(data.operation === null || isOperation(data.operation)) || !Array.isArray(data.browsers) || !data.browsers.every(isBrowser) || !Array.isArray(data.timeline) || !data.timeline.every(isEntry)) return state;
    const operation = data.operation;
    return { ...state, operation, browsers: data.browsers, timeline: data.timeline.slice(-20), stopping: !!operation && operation.id === state.operation?.id && state.stopping, stopped: operation ? false : state.stopped };
  }
  if (message.kind === "stop-requested") return { ...state, stopping: true, stopped: false, error: null };
  if (message.kind === "stop-completed") {
    const replacement = state.operation && state.operation.id !== message.operationId;
    return { ...state, operation: replacement ? state.operation : null, stopping: false, stopped: !replacement && message.confirmed !== false, error: null };
  }
  if (message.kind === "request-failed" && typeof message.message === "string") return { ...state, stopping: false, error: message.message };
  if (message.kind === "clear-error") return { ...state, error: null };
  return state;
}
