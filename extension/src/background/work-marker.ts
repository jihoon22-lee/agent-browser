/** Runs in the page: a fixed, click-through, closed-shadow frame that snapshots cannot read. */
export function markerScript(on: boolean, label: string): void {
  const id = "agent-browser-work-marker";
  // Replace every earlier marker, including ones left by a previous extension instance.
  document.querySelectorAll(`#${id}`).forEach(element => element.remove());
  if (!on) return;
  const host = document.createElement("div");
  host.id = id; host.setAttribute("aria-hidden", "true");
  // Important, so page CSS (div{pointer-events:auto!important}) cannot make it block clicks.
  for (const [name, value] of ([["all", "initial"], ["position", "fixed"], ["inset", "0"], ["pointer-events", "none"], ["z-index", "2147483647"], ["display", "block"]] as [string, string][]))
    host.style.setProperty(name, value, "important");
  const root = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("div");
  frame.style.cssText = "position:absolute;inset:0;border:3px solid #2563eb;box-sizing:border-box";
  const tag = document.createElement("div");
  tag.style.cssText = "position:absolute;top:0;right:0;background:#2563eb;color:#fff;font:12px sans-serif;padding:2px 8px";
  tag.textContent = label;
  root.append(frame, tag);
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

export type SessionArea = { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> };

/** Tabs that may carry a marker: this worker's memory, else the session record (worker restart),
 * else every web tab (a new extension instance cannot know what an earlier one marked). */
export async function markedBefore(session: SessionArea, webTabs: () => Promise<number[]>, inMemory: Set<number> | null): Promise<Set<number>> {
  if (inMemory) return inMemory;
  const saved = (await session.get("markedTabs")).markedTabs;
  if (Array.isArray(saved)) return new Set(saved.filter(Number.isInteger));
  return new Set(await webTabs());
}

/** A marked tab whose top document changed lost its marker with the old document. */
export function shouldRemark(tabId: number, frameId: number, marked: Set<number> | null): boolean {
  return frameId === 0 && !!marked?.has(tabId);
}
