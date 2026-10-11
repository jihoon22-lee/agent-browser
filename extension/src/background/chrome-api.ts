import type { KeyValueStore } from "./bridge-connection";

export const chromeStorage: KeyValueStore = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};
