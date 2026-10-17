import { watchesLateNavigation } from "../src/background/late-navigation";

it("watches only an action that saw no change and opened no tab", () => {
  expect(watchesLateNavigation({ verified: { urlChanged: false, domChanged: false } })).toBe(true);
  expect(watchesLateNavigation({ verified: { submitted: true } })).toBe(true);
  expect(watchesLateNavigation({ verified: { urlChanged: false, domChanged: true } })).toBe(false);
  expect(watchesLateNavigation({ verified: { clicked: true } })).toBe(false);
  expect(watchesLateNavigation({ verified: { urlChanged: false, domChanged: false }, openedTabs: [{ tabId: 9 }] })).toBe(false);
});
