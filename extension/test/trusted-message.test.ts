import { acceptTrustedRequest } from "../src/background/trusted-message";

it("accepts only a running click or press of this tab's top frame", () => {
  const ctx = { runtimeId: "ext", running: (tab: number, id: string, method: string) => tab === 1 && id === "r1" && method === "browser.click", enabled: true, attached: (tab: number) => tab === 1 };
  const ok = { kind: "trusted-input", requestId: "r1", action: "click", x: 1, y: 2 };
  const top = { id: "ext", tab: { id: 1 }, frameId: 0 };
  expect(acceptTrustedRequest(ok, top, ctx)).toBe(true);
  expect(acceptTrustedRequest(ok, { ...top, id: "other" }, ctx)).toBe(false);
  expect(acceptTrustedRequest(ok, { ...top, tab: { id: 2 } }, ctx)).toBe(false);
  expect(acceptTrustedRequest(ok, { ...top, frameId: 3 }, ctx)).toBe(false);
  expect(acceptTrustedRequest({ ...ok, requestId: "old" }, top, ctx)).toBe(false);
  expect(acceptTrustedRequest({ ...ok, action: "key", key: "Enter" }, top, ctx)).toBe(false);
  expect(acceptTrustedRequest(ok, top, { ...ctx, enabled: false })).toBe(false);
  expect(acceptTrustedRequest(ok, top, { ...ctx, attached: () => false })).toBe(false);
  expect(acceptTrustedRequest({ ...ok, x: Number.NaN }, top, ctx)).toBe(false);
});
