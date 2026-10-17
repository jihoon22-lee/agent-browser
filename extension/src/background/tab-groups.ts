/** Groups this browser's operation tabs as "AgentBrowser" when the optional tabGroups permission
 * is granted, and releases only the tabs it grouped itself; tabs the user grouped stay put. */
export type GroupApi = {
  groupOf(tabId: number): Promise<number>;                       // -1 when ungrouped
  group(tabIds: number[], groupId?: number): Promise<number>;
  name(groupId: number): Promise<void>;
  ungroup(tabIds: number[]): Promise<void>;
};
export type GroupState = { groupId?: number; grouped: Set<number> };

export async function syncGroup(api: GroupApi, granted: boolean, tabs: number[], previous: GroupState): Promise<GroupState> {
  const keep = granted ? new Set(tabs) : new Set<number>();
  const leaving = [...previous.grouped].filter(tab => !keep.has(tab));
  if (leaving.length) await api.ungroup(leaving).catch(() => {});
  const grouped = new Set([...previous.grouped].filter(tab => keep.has(tab)));
  let groupId = grouped.size ? previous.groupId : undefined;
  const joining: number[] = [];
  for (const tab of keep) {
    if (grouped.has(tab)) continue;
    const current = await api.groupOf(tab).catch(() => -2);
    if (current === -1) joining.push(tab);
  }
  if (joining.length) {
    try {
      const fresh = groupId === undefined;
      groupId = await api.group(joining, groupId);
      if (fresh) await api.name(groupId);
      for (const tab of joining) grouped.add(tab);
    } catch { /* A closed tab or window change: the next status update retries. */ }
  }
  return { groupId, grouped };
}

export function chromeGroups(): GroupApi {
  return {
    groupOf: async tabId => (await chrome.tabs.get(tabId)).groupId ?? -1,
    group: (tabIds, groupId) => chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], ...(groupId === undefined ? {} : { groupId }) }),
    name: async groupId => { await chrome.tabGroups.update(groupId, { title: "AgentBrowser", color: "blue" }); },
    ungroup: tabIds => chrome.tabs.ungroup(tabIds as [number, ...number[]]),
  };
}
