import { ProtocolError } from "../protocol/errors";
import { pageText } from "./snapshot";
import { resolveRef } from "./refs";
import { cancellationError } from "./cancellation";
import { observePage } from "./observe";

/** Internal read-only probe used across document replacements by the background waiter. */
export function textConditions(p: Record<string,unknown>): Record<string,boolean> {
  const text=pageText(document),result:Record<string,boolean>={};
  if(typeof p.text==='string')result.text=text.includes(p.text);
  if(typeof p.textGone==='string')result.textGone=!text.includes(p.textGone);
  return result;
}

export function waitFor(p: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(cancellationError());
  const conds: [string, () => boolean][] = [];
  if (typeof p.text === "string") conds.push(["text", () => pageText(document).includes(p.text as string)]);
  if (typeof p.textGone === "string") conds.push(["textGone", () => !pageText(document).includes(p.textGone as string)]);
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
    const check = () => {
      const met = p.match==='all' ? (conds.every(([,f])=>f()) ? 'all' : undefined) : conds.find(([,f])=>f())?.[0];
      if (met) { done(); resolve({ executed: false, verified: { met }, elapsedMs: Date.now() - start }); return true; }
      return false;
    };
    const mo = observePage(() => check());
    const poll = setInterval(() => { mo.refresh(); check(); }, 250);
    const timer = setTimeout(() => { done(); reject(new ProtocolError("TIMEOUT", `Condition not met within ${timeout} ms.`, "safe", { conditions: conds.map(([k]) => k) })); }, timeout);
    const done = () => { mo.disconnect(); clearInterval(poll); clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { done(); reject(cancellationError()); };
    signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}
