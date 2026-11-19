import { operationChanges, statusOperations } from "../src/background/operations";

it("reads every operation, or the single one an older Bridge sends", () => {
  const a = { id: "op-a", clientId: "me", tabs: [1] }, b = { id: "op-b", clientId: "me", tabs: [2] };
  expect(statusOperations({ operation: a, operations: [a, b] })).toEqual([a, b]);
  expect(statusOperations({ operation: a })).toEqual([a]);
  expect(statusOperations({ operation: null })).toEqual([]);
  expect(statusOperations({ operations: [a, { id: 3 }] })).toEqual([a]);
  expect(statusOperations(undefined)).toEqual([]);
});

it("names ended operations and the ones whose target or holder changed", () => {
  const before = [{ id: "a", clientId: "me", currentTab: 1 }, { id: "b", clientId: "me", currentTab: 2 }, { id: "c", clientId: "me", currentTab: 3 }];
  const after = [{ id: "b", clientId: "me", currentTab: 5 }, { id: "c", clientId: "me", currentTab: 3, paused: true }, { id: "d", clientId: "me", currentTab: 4 }];
  expect(operationChanges(before, after)).toEqual({ ended: ["a"], moved: ["b", "c"] });
});
