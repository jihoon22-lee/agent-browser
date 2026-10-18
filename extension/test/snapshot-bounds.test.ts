import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry, resolveRef } from "../src/content/refs";
const options = { snapshotId: 1, frameId: 0, maxChars: 200, offset: 0, checkLayout: false };
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });
it("bounds giant field values, option labels, hrefs and aggregate snapshot JSON", () => {
  document.body.innerHTML = "<textarea aria-label='large'></textarea><select></select><a>link</a>";
  document.querySelector("textarea")!.value = "x".repeat(500000);
  document.querySelector("select")!.innerHTML = Array.from({ length: 300 }, () => `<option>${"y".repeat(2000)}</option>`).join("");
  document.querySelector("a")!.href = "https://example.test/" + "q".repeat(100000);
  const snapshot = takeSnapshot(options);
  expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(32768);
  expect(snapshot.elements[0]!.value!.length).toBeLessThanOrEqual(512);
  expect(snapshot.limits).toContain("element-fields-truncated");
  // About 2.5 s alone on half a megabyte of fixture data; the default 5 s fails under a parallel suite.
}, 20_000);
it("paginates more than150 elements independently from text offset", () => {
  document.body.innerHTML = Array.from({ length: 175 }, (_, i) => `<button>button${i}</button>`).join("");
  const first = takeSnapshot(options);
  expect(first).toMatchObject({ elementsTotal: 175, elementsOffset: 0, elementsNextOffset: 150 });
  const next = takeSnapshot({ ...options, snapshotId: 2, elementOffset: first.elementsNextOffset! });
  expect(next.elements).toHaveLength(25); expect(next.elements[0]!.name).toBe("button150");
  expect(resolveRef(next.elements[24]!.ref).textContent).toBe("button174");
  expect(next.elementsNextOffset).toBeNull(); expect(next.text.offset).toBe(0);
});
it("pages the aggregate size bound without losing the next element", () => {
  document.body.innerHTML = Array.from({ length: 160 }, (_, i) => `<textarea aria-label='field${i}'>${"v".repeat(1000)}</textarea>`).join("");
  const first = takeSnapshot(options);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(32768);
  expect(first.elementsNextOffset).toBe(first.elements.length);
  const next = takeSnapshot({ ...options, snapshotId: 2, elementOffset: first.elementsNextOffset! });
  expect(next.elements[0]!.name).toBe(`field${first.elements.length}`);
});
it("gives plain tables refs so a second table can be extracted", () => {
  document.body.innerHTML = "<table><tr><td>first</td></tr></table><table><caption>second</caption><tr><td>other</td></tr></table>";
  const snapshot = takeSnapshot(options);
  expect(snapshot.elements.filter(e => e.role === "table")).toHaveLength(2);
  expect(resolveRef(snapshot.elements[1]!.ref)).toBe(document.querySelectorAll("table")[1]);
});

it("bounds escaped control characters and still returns a useful element page", () => {
  document.body.innerHTML = "<p></p><select aria-label='escaped'></select>";
  document.querySelector("p")!.textContent = "\u0001".repeat(50000);
  document.querySelector("select")!.append(...Array.from({ length: 30 }, () => { const option = document.createElement("option"); option.textContent = "\u0001".repeat(500); return option; }));
  const page = takeSnapshot({ ...options, maxChars: 20000 });
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(32768);
  expect(page.elements).toHaveLength(1); expect(page.text.nextOffset).toBe(page.text.returnedChars);
});
