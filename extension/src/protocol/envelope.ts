import { ProtocolError, type RpcError } from "./errors";
export { ERROR_CODES, ProtocolError } from "./errors";
export type { ErrorCode, Retry, RpcError } from "./errors";

export const PROTOCOL_VERSION = 1 as const;
export type Req = { v: 1; type: "req"; id: string; method: string; params: Record<string, unknown> };
export type Res = { v: 1; type: "res"; id: string; ok: boolean; result?: unknown; error?: RpcError };
export type Evt = { v: 1; type: "evt"; event: string; data: unknown };
export type Envelope = Req | Res | Evt;

export function parseEnvelope(text: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ProtocolError("INVALID_PARAMS", `invalid JSON: ${String(e)}`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj?.v !== PROTOCOL_VERSION) {
    throw new ProtocolError("PROTOCOL_VERSION_UNSUPPORTED", `protocol version ${String(obj?.v)} is not supported`);
  }
  switch (obj.type) {
    case "req":
      if (typeof obj.id === "string" && typeof obj.method === "string" && typeof obj.params === "object" && obj.params !== null) return obj as Req;
      break;
    case "res":
      if (typeof obj.id === "string" && typeof obj.ok === "boolean") return obj as Res;
      break;
    case "evt":
      if (typeof obj.event === "string" && "data" in obj) return obj as Evt;
      break;
  }
  throw new ProtocolError("INVALID_PARAMS", "invalid envelope");
}

export const makeReq = (method: string, params: Record<string, unknown>): Req =>
  ({ v: 1, type: "req", id: `req-${crypto.randomUUID()}`, method, params });
export const makeOk = (id: string, result: unknown): Res => ({ v: 1, type: "res", id, ok: true, result });
export const makeErr = (id: string, error: RpcError): Res => ({ v: 1, type: "res", id, ok: false, error });
export const makeEvt = (event: string, data: unknown): Evt => ({ v: 1, type: "evt", event, data });
