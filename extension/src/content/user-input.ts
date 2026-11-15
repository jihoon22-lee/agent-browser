/** Only physical input invalidates popup attribution. Agent DOM events are
 * synthetic; focus events are intentionally excluded because focus() is trusted. */
export function observeUserInput(target: EventTarget) {
  let epoch = 0;
  const document = crypto.randomUUID();
  const changed = (event: Event) => { if (event.isTrusted && !absorbed(event.type)) epoch++; };
  for (const name of ['pointerdown','pointerup','mousedown','mouseup','keydown','keyup','click','auxclick','contextmenu']) {
    target.addEventListener(name, changed, true);
  }
  return () => ({ document, epoch });
}

type Counts = Partial<Record<string, number>>;
/** Events the agent's own trusted input is still expected to produce. One content script world per frame. */
let pending: Counts | undefined, delivering = 0;
const absorbed = (type: string) => { const left = pending?.[type] ?? 0; if (left <= 0) return false; pending![type] = left - 1; return true; };

/** The trusted events one agent input produces in the page (see background/trusted-input.ts). */
export function agentEvents(action: string, payload: { mode?: unknown; modifiers?: unknown; text?: unknown }): Counts {
  const pointer = (presses: number, extra: Counts): Counts => ({ pointerdown: presses, mousedown: presses, pointerup: presses, mouseup: presses, ...extra });
  if (action === 'click') return payload.mode === 'hover' ? {} : payload.mode === 'right' ? pointer(1, { contextmenu: 1, auxclick: 1 }) : payload.mode === 'double' ? pointer(2, { click: 2 }) : pointer(1, { click: 1 });
  // A drag may end with a click on the element both ends share.
  if (action === 'drag') return pointer(1, { click: 1 });
  if (action === 'key') { const keys = 1 + (Array.isArray(payload.modifiers) ? payload.modifiers.length : 0); return { keydown: keys, keyup: keys }; }
  // Text is inserted without key events; only clearing presses Backspace.
  if (action === 'text') return payload.text ? {} : { keydown: 1, keyup: 1 };
  return {};
}

/** Debugger input arrives as isTrusted events, like a person's. While the agent's own input is being
 * delivered, exactly the events it produces are not counted as the user's; anything beyond them is. */
export async function asAgentInput<T>(events: Counts, work: () => Promise<T>): Promise<T> {
  pending ??= {};
  for (const [type, count] of Object.entries(events)) pending[type] = (pending[type] ?? 0) + (count ?? 0);
  delivering++;
  try { return await work(); }
  finally { if (--delivering === 0) pending = undefined; }
}
