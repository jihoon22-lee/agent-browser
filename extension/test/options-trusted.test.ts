import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TrustedInputSetting } from "../src/options/TrustedInputSetting";

let root: Root, host: HTMLDivElement;
const storage: Record<string, unknown> = {};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const key of Object.keys(storage)) delete storage[key];
  vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => ({ ...storage })), set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(storage, value); }) } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("turns trusted input on and off, explaining the debugging bar", async () => {
  await act(async () => { root.render(createElement(TrustedInputSetting)); await new Promise(r => setTimeout(r, 0)); });
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(box.checked).toBe(false);
  await act(async () => { box.click(); await new Promise(r => setTimeout(r, 0)); });
  expect(storage.trustedInput).toBe(true);
  expect(host.textContent).toContain("디버깅하는 중");
  await act(async () => { box.click(); await new Promise(r => setTimeout(r, 0)); });
  expect(storage.trustedInput).toBe(false);
});
