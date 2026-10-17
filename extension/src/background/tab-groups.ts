/** Groups this browser's operation tabs as "AgentBrowser" when the optional tabGroups permission
 * is granted, and releases only the tabs it grouped itself; tabs the user grouped stay put.
 * A group belongs to one window, so each window gets its own group and no tab changes window. */
export type GroupApi = {
  groupOf(tabId: number): Promise<number>;                       // -1 when ungrouped
  windowOf(tabId: number): Promise<number>;
  group(tabIds: number[], groupId: number | undefined, windowId: number): Promise<number>;
  name(groupId: number): Promise<void>;
  ungroup(tabIds: number[]): Promise<void>;
};
export type GroupState = { groups?: Map<number, number>; grouped: Set<number> };

export async function syncGroup(api: GroupApi, granted: boolean, tabs: number[], previous: GroupState): Promise<GroupState> {
  const keep = granted ? new Set(tabs) : new Set<number>();
  // One call per tab: a closed tab must not keep the others grouped.
  for (const tab of [...previous.grouped].filter(tab => !keep.has(tab))) await api.ungroup([tab]).catch(() => {});
  const grouped = new Set([...previous.grouped].filter(tab => keep.has(tab)));
  const groups = new Map(grouped.size ? previous.groups ?? [] : []);
  const joining = new Map<number, number[]>();
  for (const tab of keep) {
    if (grouped.has(tab)) continue;
    if (await api.groupOf(tab).catch(() => -2) !== -1) continue;
    const windowId = await api.windowOf(tab).catch(() => undefined);
    if (windowId !== undefined) joining.set(windowId, [...(joining.get(windowId) ?? []), tab]);
  }
  for (const [windowId, tabIds] of joining) {
    const existing = groups.get(windowId);
    let groupId: number;
    try { groupId = await api.group(tabIds, existing, windowId); }
    catch {
      // A group the user closed: start a fresh one in that window.
      if (existing === undefined) continue;
      try { groupId = await api.group(tabIds, undefined, windowId); } catch { continue; }
    }
    for (const tab of tabIds) grouped.add(tab);
    if (groupId !== existing) { groups.set(windowId, groupId); await api.name(groupId).catch(() => {}); }
  }
  return { groups, grouped };
}

export function chromeGroups(): GroupApi {
  return {
    groupOf: async tabId => (await chrome.tabs.get(tabId)).groupId ?? -1,
    windowOf: async tabId => (await chrome.tabs.get(tabId)).windowId,
    group: (tabIds, groupId, windowId) => chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }) }),
    name: async groupId => { await chrome.tabGroups.update(groupId, { title: "AgentBrowser", color: "blue" }); },
    ungroup: tabIds => chrome.tabs.ungroup(tabIds as [number, ...number[]]),
  };
}
