import { ProtocolError } from "../protocol/errors";

export type CommandScope = { operationId?: string; generation?: number; requestId?: string };
const cancelledOperations = new Set<string>();
const cancelledRequests = new Set<string>();
const running = new Set<{ scope: CommandScope; controller: AbortController }>();
let cancelledGeneration = 0;

export function cancellationError(executed = false): ProtocolError {
  return new ProtocolError("CANCELLED", "This command was stopped.", "never", { executed });
}

function isCancelled(scope: CommandScope): boolean {
  return (!!scope.operationId && cancelledOperations.has(scope.operationId))
    || (!!scope.requestId && cancelledRequests.has(scope.requestId))
    // Legacy callers without operation IDs still support generation cancellation.
    // Production commands use operation IDs because generations restart with the bridge.
    || (!scope.operationId && scope.generation !== undefined && scope.generation <= cancelledGeneration);
}

export function checkCancelled(scope: CommandScope, signal?: AbortSignal): void {
  if (signal?.aborted || isCancelled(scope)) throw cancellationError();
}

export function cancelCommands(scope: CommandScope): void {
  if (scope.requestId) cancelledRequests.add(scope.requestId);
  else if (scope.operationId) cancelledOperations.add(scope.operationId);
  else if (typeof scope.generation === "number") cancelledGeneration = Math.max(cancelledGeneration, scope.generation);
  for (const command of running) {
    if (isCancelled(command.scope)) command.controller.abort();
  }
}

export async function withCommandCancellation<T>(scope: CommandScope, run: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  checkCancelled(scope, signal);
  const command = { scope, controller: new AbortController() };
  const abort = () => command.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running.add(command);
  try { return await run(command.controller.signal); }
  finally {
    running.delete(command);
    signal?.removeEventListener("abort", abort);
  }
}
