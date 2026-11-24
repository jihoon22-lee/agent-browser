import { ProtocolError } from "../protocol/errors";
import { pageText } from "./snapshot";

/** Words as a person reads them: case, runs of spaces, the tab between table cells and a
 * non-breaking space do not matter. browser_snapshot's query reads the page the same way. */
const fold = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
const shows = (text: string, wanted: string) => text.includes(wanted) || fold(text).includes(fold(wanted));
import { resolveRef } from "./refs";
import { cancellationError } from "./cancellation";
import { observePage } from "./observe";

/** Internal read-only probe used across document replacements by the background waiter. */
export function textConditions(p: Record<string,unknown>): Record<string,boolean> {
  const text=pageText(document),result:Record<string,boolean>={};
  if(typeof p.text==='string')result.text=shows(text,p.text);
  if(typeof p.textGone==='string')result.textGone=!shows(text,p.textGone);
  return result;
}

export function waitFor(p: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(cancellationError());
  const conds: [string, (text: () => string) => boolean][] = [];
  if (typeof p.text === "string") conds.push(["text", text => shows(text(), p.text as string)]);
  if (typeof p.textGone === "string") conds.push(["textGone", text => !shows(text(), p.textGone as string)]);
  if (typeof p.refGone === "string") {
    // Capture the known node once: snapshot-cache eviction says nothing about its DOM lifetime.
    try {
      const node = resolveRef(p.refGone, true);
      conds.push(["refGone", () => !node.isConnected]);
    } catch (error) { return Promise.reject(error); }
  }
  if (typeof p.urlIncludes === "string") conds.push(["urlIncludes", () => location.href.includes(p.urlIncludes as string)]);
  if (!conds.length) return Promise.reject(new ProtocolError("INVALID_PARAMS", "browser_wait needs text, textGone, refGone or urlIncludes."));
  const timeout = Math.min(Number(p.timeoutMs ?? 5000), 30_000);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const check = () => {
      if (settled) return true;
      let cachedText: string | undefined;
      const text = () => (cachedText ??= pageText(document));
      const met = p.match === 'all' ? (conds.every(([, f]) => f(text)) ? 'all' : undefined) : conds.find(([, f]) => f(text))?.[0];
      if (met) { done(); resolve({ executed: false, verified: { met }, elapsedMs: Date.now() - start }); return true; }
      return false;
    };
    const mo = observePage(() => { check(); });
    const poll = setInterval(() => { mo.refresh(); check(); }, 250);
    const timer = setTimeout(() => { done(); reject(new ProtocolError("TIMEOUT", `Condition not met within ${timeout} ms.`, "safe", { conditions: conds.map(([k]) => k) })); }, timeout);
    const done = () => { settled = true; mo.disconnect(); clearInterval(poll); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { done(); reject(cancellationError()); };
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}
