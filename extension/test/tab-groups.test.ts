import { syncGroup, type GroupApi } from "../src/background/tab-groups";

function fakeGroups(groups: Record<number, number> = {}) {
  const calls: string[] = [];
  const api: GroupApi = {
    groupOf: async tabId => groups[tabId] ?? -1,
    windowOf: async () => 1,
    group: async (tabIds, groupId) => { const id = groupId ?? 70; calls.push(`group ${tabIds.join(",")}${groupId ? " into " + groupId : ""}`); for (const t of tabIds) groups[t] = id; return id; },
    name: async groupId => { calls.push(`name ${groupId}`); },
    ungroup: async tabIds => { calls.push(`ungroup ${tabIds.join(",")}`); for (const t of tabIds) groups[t] = -1; },
  };
  return { api, calls };
}

it("groups operation tabs and ungroups only the tabs it grouped", async () => {
  const g = fakeGroups();
  let state = await syncGroup(g.api, true, [1, 2], { grouped: new Set() });
  state = await syncGroup(g.api, true, [1, 2, 3], state);
  state = await syncGroup(g.api, true, [3], state);
  await syncGroup(g.api, true, [], state);
  expect(g.calls).toEqual(["group 1,2", "name 70", "group 3 into 70", "ungroup 1", "ungroup 2", "ungroup 3"]);
});

it("leaves tabs the user already grouped alone", async () => {
  const g = fakeGroups({ 5: 12 });
  const state = await syncGroup(g.api, true, [5], { grouped: new Set() });
  await syncGroup(g.api, true, [], state);
  expect(g.calls).toEqual([]);
});

it("does nothing without the permission and lets go when it is revoked", async () => {
  const g = fakeGroups();
  expect((await syncGroup(g.api, false, [1], { grouped: new Set() })).grouped.size).toBe(0);
  expect(g.calls).toEqual([]);
  const state = await syncGroup(g.api, true, [1], { grouped: new Set() });
  await syncGroup(g.api, false, [1], state);
  expect(g.calls.at(-1)).toBe("ungroup 1");
});

it("keeps a separate group per window so no tab moves between windows", async () => {
  const calls: string[] = []; const where: Record<number, number> = { 1: 10, 2: 20 }; const groups: Record<number, number> = {};
  let next = 70;
  const api: GroupApi = {
    groupOf: async tab => groups[tab] ?? -1,
    windowOf: async tab => where[tab]!,
    group: async (tabIds, groupId, windowId) => { const id = groupId ?? next++; calls.push(`group ${tabIds.join(",")} ${groupId ?? "new"} w${windowId}`); for (const t of tabIds) groups[t] = id; return id; },
    name: async () => {}, ungroup: async tabIds => { for (const t of tabIds) groups[t] = -1; },
  };
  await syncGroup(api, true, [1, 2], { grouped: new Set() });
  expect(calls).toEqual(["group 1 new w10", "group 2 new w20"]);
});

it("keeps which tabs it grouped across a worker restart", async () => {
  const { loadGroupState, saveGroupState } = await import("../src/background/tab-groups");
  const stored: Record<string, unknown> = {};
  const area = { get: async (key: string) => ({ [key]: stored[key] }), set: async (value: Record<string, unknown>) => { Object.assign(stored, value); } };
  const g = fakeGroups();
  await saveGroupState(area, await syncGroup(g.api, true, [1, 2], { grouped: new Set() }));
  // A fresh worker reads the saved state and still releases exactly the tabs it grouped.
  const restored = await loadGroupState(area);
  await syncGroup(g.api, true, [], restored);
  expect(g.calls.filter(c => c.startsWith("ungroup"))).toEqual(["ungroup 1", "ungroup 2"]);
  expect((await loadGroupState({ get: async () => ({}), set: async () => {} })).grouped.size).toBe(0);
});
