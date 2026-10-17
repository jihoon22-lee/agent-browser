/** Runs in the page: a fixed, click-through, closed-shadow frame that snapshots cannot read. */
export function markerScript(on: boolean, label: string): void {
  const id = "agent-browser-work-marker";
  const existing = document.getElementById(id) as (HTMLElement & { __label?: HTMLElement }) | null;
  if (!on) { existing?.remove(); return; }
  if (existing?.__label) { existing.__label.textContent = label; return; }
  const host = document.createElement("div") as HTMLElement & { __label?: HTMLElement };
  host.id = id; host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("div");
  frame.style.cssText = "position:absolute;inset:0;border:3px solid #2563eb;box-sizing:border-box";
  const tag = document.createElement("div");
  tag.style.cssText = "position:absolute;top:0;right:0;background:#2563eb;color:#fff;font:12px sans-serif;padding:2px 8px";
  tag.textContent = label;
  root.append(frame, tag); host.__label = tag;
  document.documentElement.append(host);
}

export type MarkerApi = { executeScript(tabId: number, func: typeof markerScript, args: [boolean, string]): Promise<unknown> };

/** Frames the operation's tabs and clears tabs that left it; returns the tabs now marked. */
export async function syncMarkers(api: MarkerApi, previous: Set<number>, next: { tabs: number[]; paused: boolean } | null): Promise<Set<number>> {
  const label = next?.paused ? "AgentBrowser · 사용자가 조작 중" : "AgentBrowser 작업 중";
  const now = new Set(next?.tabs ?? []);
  for (const tab of now) await api.executeScript(tab, markerScript, [true, label]).catch(() => {});
  for (const tab of previous) if (!now.has(tab)) await api.executeScript(tab, markerScript, [false, ""]).catch(() => {});
  return now;
}
