export const ERROR_CODES = [
  "BROWSER_DISCONNECTED", "TAB_NOT_FOUND", "TAB_CLOSED", "UNSUPPORTED_PAGE", "FRAME_UNAVAILABLE",
  "STALE_ELEMENT", "ELEMENT_NOT_FOUND", "ELEMENT_NOT_INTERACTABLE", "TIMEOUT", "CANCELLED",
  "BROWSER_BUSY", "EXECUTION_UNKNOWN", "NEEDS_TAB_ACTIVATION", "OPERATION_REQUIRED",
  "OPERATION_INVALID", "INVALID_PARAMS", "AUTH_REQUIRED", "AUTH_FAILED", "NOT_PAIRED",
  "FORBIDDEN_METHOD", "PROTOCOL_VERSION_UNSUPPORTED", "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type Retry = "safe" | "unsafe" | "never";
export interface RpcError { code: ErrorCode; message: string; retry: Retry; details?: unknown }

export class ProtocolError extends Error {
  constructor(public code: ErrorCode, message: string, public retry: Retry = "never", public details?: unknown) {
    super(message);
  }
  toRpc(): RpcError {
    return this.details === undefined
      ? { code: this.code, message: this.message, retry: this.retry }
      : { code: this.code, message: this.message, retry: this.retry, details: this.details };
  }
}
