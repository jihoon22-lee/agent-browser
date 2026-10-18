/** Asks the background to send this click or key through the debugger. Any failure means
 * "use DOM events": trusted input is an improvement, never a requirement. */
export type TrustedAnswer = { ok: true; dialog?: { type: string; message: string } } | { ok: false; reason: string; dispatched?: boolean };

export async function requestTrusted(requestId: string, action: "click" | "drag" | "key", payload: Record<string, unknown>): Promise<TrustedAnswer> {
  try {
    const answer = await chrome.runtime.sendMessage({ kind: "trusted-input", requestId, action, ...payload });
    if (answer?.ok === true) return { ok: true, ...(answer.dialog ? { dialog: answer.dialog } : {}) };
    return { ok: false, reason: typeof answer?.reason === "string" ? answer.reason : "unavailable", ...(answer?.dispatched === true ? { dispatched: true } : {}) };
  } catch { return { ok: false, reason: "unavailable" }; }
}

/** Trusted input is sent to the top-level page only: debugger coordinates are top-level viewport pixels. */
export const trustedFrame = () => window === window.top;

/** Part of the input already reached the page: repeating it as DOM events could act twice. */
export function partlyDelivered(answer: TrustedAnswer): boolean { return !answer.ok && answer.dispatched === true; }
