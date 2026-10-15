import { RefTable } from "../src/content/refs";
import { memorySessionStore } from "../src/background/dedupe";

it("keeps element refs short and round-trips the snapshot id", () => {
  const id = Math.floor((Date.parse("2026-10-15T00:00:00Z") - Date.UTC(2026, 0, 1)) / 100);
  document.body.innerHTML = "<button>확인</button>";
  const ref = new RefTable(id, 0).add(document.querySelector("button")!);
  expect(ref.length).toBeLessThanOrEqual(12);
  expect(RefTable.parse(ref)).toEqual({ snapshotId: id, frameId: 0, index: 1 });
});

it("migrates legacy microsecond snapshot sequences to short ids", async () => {
  const backing = new Map<string, unknown>([["commandSession", { requests: {}, cancelled: {}, legacyGeneration: 0, sequence: 1760500000000001, bindings: {} }]]);
  const store = memorySessionStore(backing);
  const id = await store.nextSnapshotId();
  expect(id).toBeLessThan(1e10);
  expect(await store.nextSnapshotId()).toBeGreaterThan(id);
});
