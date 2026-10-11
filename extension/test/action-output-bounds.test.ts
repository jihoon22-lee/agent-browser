import { runAction } from "../src/content/actions";
import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
const ref = () => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 200, offset: 0, checkLayout: false }).elements[0]!.ref;
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

it("bounds a fill value changed by page listeners while comparing the full result", async () => {
  document.body.innerHTML = "<input aria-label='입력'>";
  document.querySelector("input")!.addEventListener("input", e => { (e.target as HTMLInputElement).value = "x".repeat(500000); });
  const result = await runAction("fill", { generation: 1, ref: ref(), text: "short" });
  expect((result.verified as { value: string }).value.length).toBe(512);
  expect(result).toMatchObject({ verified: { value: "x".repeat(512), valueTruncated: true, matches: false } });
  expect(JSON.stringify(result).length).toBeLessThan(800);
});
it("does not mistake a matching prefix for a matching full field value", async () => {
  document.body.innerHTML = "<textarea aria-label='내용'></textarea>";
  const requested = "x".repeat(600);
  const result = await runAction("fill", { generation: 1, ref: ref(), text: requested });
  expect((result.verified as { value: string }).value.length).toBe(512);
  expect(result).toMatchObject({ verified: { value: "x".repeat(512), valueTruncated: true, matches: true } });
});
it("bounds contenteditable verification after a page listener expands it", async () => {
  document.body.innerHTML = "<div contenteditable='true' aria-label='편집'></div>";
  const element = document.querySelector("div")!;
  Object.defineProperty(element, "isContentEditable", { value: true, configurable: true });
  element.addEventListener("input", () => { element.textContent = "z".repeat(500000); });
  const result = await runAction("fill", { generation: 1, ref: ref(), text: "short" });
  expect((result.verified as { value: string }).value.length).toBe(512);
  expect(result).toMatchObject({ verified: { value: "z".repeat(512), valueTruncated: true, matches: false } });
});
it("continues masking password values even when a page listener replaces them", async () => {
  document.body.innerHTML = "<input type='password' aria-label='암호'>";
  document.querySelector("input")!.addEventListener("input", e => { (e.target as HTMLInputElement).value = "secret".repeat(100000); });
  const result = await runAction("fill", { generation: 1, ref: ref(), text: "short" });
  expect(result).toMatchObject({ verified: { matches: false } });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(result.verified).not.toHaveProperty("value");
});
it("bounds selected option value and label and marks both as truncated", async () => {
  document.body.innerHTML = "<select aria-label='목록'><option></option></select>";
  const option = document.querySelector("option")!;
  option.value = "v".repeat(100000); option.text = "label".repeat(100000);
  const result = await runAction("select", { generation: 1, ref: ref(), option: option.value });
  expect((result.verified as { value: string }).value.length).toBe(512);
  expect(result).toMatchObject({ verified: { value: "v".repeat(512), label: option.text.slice(0, 512), valueTruncated: true, labelTruncated: true } });
  expect(JSON.stringify(result).length).toBeLessThan(1300);
});
it("bounds missing-option error details and requested text", async () => {
  document.body.innerHTML = "<select aria-label='목록'></select>";
  const select = document.querySelector("select")!;
  for (let i = 0; i < 100; i++) { const option = document.createElement("option"); option.text = `label${i}:` + "x".repeat(10000); select.append(option); }
  const error = await runAction("select", { generation: 1, ref: ref(), option: "missing".repeat(10000) }).catch(error => error);
  expect(error.code).toBe("ELEMENT_NOT_FOUND");
  expect(error.details.options).toHaveLength(20);
  expect(error.details.options[0].length).toBeLessThanOrEqual(128);
  expect(error.details.optionsTruncated).toBe(true);
  expect(JSON.stringify(error.toRpc()).length).toBeLessThan(4000);
});
