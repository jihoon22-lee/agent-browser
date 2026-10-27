import { cancellationError, checkCancelled, type CommandScope } from './cancellation';
import { ProtocolError } from '../protocol/errors';

/** Only a positive acknowledgement that no input was attempted permits DOM fallback.
 * A lost reply says nothing about whether the native input reached the page. */
export type TrustedAnswer = { ok: true; incomplete?:boolean; dialog?: { type: string; message: string } }
  | { ok: false; reason: string; dispatched: boolean; cancelled?: boolean; verificationFailed?:boolean };

export async function requestTrusted(requestId: string, action: "click" | "drag" | "key" | "text", payload: Record<string, unknown>): Promise<TrustedAnswer> {
  try {
    const answer = await chrome.runtime.sendMessage({ kind: "trusted-input", requestId, action, ...payload });
    if (answer?.ok === true) return { ok: true, ...(answer.incomplete?{incomplete:true}:{}), ...(answer.dialog ? { dialog: answer.dialog } : {}) };
    return { ok: false, reason: typeof answer?.reason === "string" ? answer.reason : "unavailable",
      dispatched: !(answer?.ok === false && answer.dispatched === false), cancelled: answer?.cancelled === true, verificationFailed:answer?.verificationFailed===true };
  } catch { return { ok: false, reason: "unavailable", dispatched: true }; }
}

/** Trusted input is sent to the top-level page only: debugger coordinates are top-level viewport pixels. */
export const trustedFrame = () => window === window.top;

export function assertTrustedFallback(answer: Extract<TrustedAnswer, { ok: false }>, scope: CommandScope, signal: AbortSignal): void {
  if (answer.dispatched) throw new ProtocolError('EXECUTION_UNKNOWN', 'Trusted input may have reached the page, but its outcome could not be confirmed. Inspect the page before retrying.', 'unsafe');
  if(answer.verificationFailed)throw new ProtocolError('STALE_ELEMENT','The target changed before native input. Observe it again.','safe',{executed:false});
  if (answer.cancelled) throw new ProtocolError('CANCELLED','Stopped before native input.','never',{executed:false,deliveryKnown:true});
  checkCancelled(scope, signal);
}
