/** A running Bridge operation as the status event reports it. */
export type LiveOperation = { id: string; clientId: string; generation?: number; tabs?: number[]; currentTab?: number; paused?: boolean };
const valid = (value: unknown): value is LiveOperation => !!value && typeof value === "object"
  && typeof (value as LiveOperation).id === "string" && typeof (value as LiveOperation).clientId === "string";

/** Every running operation in a status payload; an older Bridge reports only `operation`. */
export function statusOperations(data: unknown): LiveOperation[] {
  const status = (data ?? {}) as { operation?: unknown; operations?: unknown };
  if (Array.isArray(status.operations)) return status.operations.filter(valid);
  return valid(status.operation) ? [status.operation] : [];
}

/** Which operations ended, and which moved to another tab or changed hands with the person. */
export function operationChanges(before: LiveOperation[], after: LiveOperation[]): { ended: string[]; moved: string[] } {
  const next = new Map(after.map(op => [op.id, op]));
  return {
    ended: before.filter(op => !next.has(op.id)).map(op => op.id),
    moved: before.filter(op => { const now = next.get(op.id); return !!now && (now.currentTab !== op.currentTab || now.paused !== op.paused); }).map(op => op.id),
  };
}
