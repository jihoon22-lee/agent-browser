import { syncGroup, type GroupApi } from "../src/background/tab-groups";

function fakeGroups(groups: Record<number, number> = {}) {
  const calls: string[] = [];
  const api: GroupApi = {
    groupOf: async tabId => groups[tabId] ?? -1,
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
  expect(g.calls).toEqual(["group 1,2", "name 70", "group 3 into 70", "ungroup 1,2", "ungroup 3"]);
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
