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

it("accepts pointer modes but not drag or unknown modes through the click action", () => {
  const ctx = { runtimeId: "ext", running: () => true, enabled: true, attached: () => true };
  const top = { id: "ext", tab: { id: 1 }, frameId: 0 };
  for (const mode of ["double", "right", "hover"]) expect(acceptTrustedRequest({ kind: "trusted-input", requestId: "r", action: "click", x: 1, y: 1, mode }, top, ctx)).toBe(true);
  for (const mode of ["drag", "triple"]) expect(acceptTrustedRequest({ kind: "trusted-input", requestId: "r", action: "click", x: 1, y: 1, mode }, top, ctx)).toBe(false);
});

it("accepts a drag only with finite source and target points", () => {
  const ctx = { runtimeId: "ext", running: () => true, enabled: true, attached: () => true };
  const top = { id: "ext", tab: { id: 1 }, frameId: 0 };
  const drag = { kind: "trusted-input", requestId: "r", action: "drag", x: 1, y: 1, toX: 9, toY: 9 };
  expect(acceptTrustedRequest(drag, top, ctx)).toBe(true);
  expect(acceptTrustedRequest({ ...drag, toX: Number.NaN }, top, ctx)).toBe(false);
  expect(acceptTrustedRequest(drag, top, { ...ctx, running: (_t: number, _r: string, method: string) => method === "browser.press" })).toBe(false);
});

it("accepts key modifiers only from the allowed set", () => {
  const ctx = { runtimeId: "ext", running: () => true, enabled: true, attached: () => true };
  const top = { id: "ext", tab: { id: 1 }, frameId: 0 };
  const key = { kind: "trusted-input", requestId: "r", action: "key", key: "a", modifiers: ["Control", "Shift"] };
  expect(acceptTrustedRequest(key, top, ctx)).toBe(true);
  expect(acceptTrustedRequest({ ...key, modifiers: ["Control", "Hyper"] }, top, ctx)).toBe(false);
  expect(acceptTrustedRequest({ ...key, modifiers: "Control" }, top, ctx)).toBe(false);
});
