import { ProtocolError } from "../protocol/errors";
import { pageText } from "./snapshot";
import { resolveRef } from "./refs";
import { cancellationError } from "./cancellation";
import { observePage } from "./observe";

export function waitFor(p: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal?.aborted) return Promise.reject(cancellationError());
  const conds: [string, () => boolean][] = [];
  if (typeof p.text === "string") conds.push(["text", () => pageText(document).includes(p.text as string)]);
  if (typeof p.textGone === "string") conds.push(["textGone", () => !pageText(document).includes(p.textGone as string)]);
  if (typeof p.refGone === "string") conds.push(["refGone", () => { try { resolveRef(p.refGone as string); return false; } catch { return true; } }]);
  if (typeof p.urlIncludes === "string") conds.push(["urlIncludes", () => location.href.includes(p.urlIncludes as string)]);
  if (!conds.length) return Promise.reject(new ProtocolError("INVALID_PARAMS", "browser_wait needs text, textGone, refGone or urlIncludes."));
  const timeout = Math.min(Number(p.timeoutMs ?? 5000), 30_000);
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const met = conds.find(([, f]) => f());
      if (met) { done(); resolve({ executed: false, verified: { met: met[0] }, elapsedMs: Date.now() - start }); return true; }
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
