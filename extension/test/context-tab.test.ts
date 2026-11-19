import { contextTab } from "../src/background/context-tab";

const tabs: Record<number, chrome.tabs.Tab> = {
  1: { id: 1, url: "https://work.test" } as chrome.tabs.Tab,
  5: { id: 5, url: "https://popup.test" } as chrome.tabs.Tab,
  9: { id: 9, url: "https://active.test" } as chrome.tabs.Tab,
};
const api = { get: vi.fn(async (id: number) => tabs[id]!), active: vi.fn(async () => tabs[9]) };
beforeEach(() => { api.get.mockClear(); api.active.mockClear(); });

it("reads the operation's tab while one is running, even when a tab is chosen", async () => {
  expect((await contextTab({ operation: { clientId: "me", currentTab: 1 } }, "me", 5, api))?.id).toBe(1);
});
it("reads the chosen tab when no operation is running", async () => {
  expect((await contextTab({}, "me", 5, api))?.id).toBe(5);
  expect(api.active).not.toHaveBeenCalled();
});
it("reads the active tab when nothing is chosen, as before", async () => {
  expect((await contextTab(undefined, "me", undefined, api))?.id).toBe(9);
});
it("refuses an operation that belongs to another browser", async () => {
  await expect(contextTab({ operation: { clientId: "other", currentTab: 1 } }, "me", 5, api)).rejects.toThrow("다른 브라우저");
});
