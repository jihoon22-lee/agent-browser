import { takeSnapshot, sliceText } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
import { runAction } from "../src/content/actions";
import { extract } from "../src/content/extract";
import { safeSlice, clipText } from "../src/content/text";
import { trackCreatedTabs } from "../src/background/tab-routing";
import { readBookmarks } from "../src/background/bookmarks";

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// JSON.stringify writes a lone surrogate as a \udXXX escape (a pair stays literal), which is what a strict parser rejects.
const lone = (value: unknown) => { const json = JSON.stringify(value); return LONE.test(json) || /\\ud[89a-f][0-9a-f]{2}/i.test(json); };
const wellFormed = (value: unknown) => expect(lone(value)).toBe(false);
const snap = (extra: Record<string, unknown> = {}) => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false, ...extra });
beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });

it("the shared helper never splits a surrogate pair at either end", () => {
  expect(safeSlice("ab😀cd", 0, 3)).toBe("ab");
  expect(safeSlice("ab😀cd", 3, 6)).toBe("😀cd");
  expect(clipText("😀😀", 3)).toBe("😀");
  // Progress is guaranteed even when the limit is smaller than one character.
  expect(safeSlice("😀a", 0, 1)).toBe("😀");
  expect(clipText("abc", 5)).toBe("abc");
});
it("keeps an emoji at the 80-character name boundary whole", () => {
  document.body.innerHTML = `<button>${"n".repeat(79)}😀 tail</button><p>x</p>`;
  const result = snap();
  expect(result.elements[0]!.name).toBe("n".repeat(79));
  wellFormed(result);
});
it("pages text across an emoji at maxChars and reassembles the original", () => {
  const original = `${"a".repeat(9)}😀${"b".repeat(9)}😀😀${"c".repeat(7)}`;
  document.body.innerHTML = `<p>${original}</p>`;
  let offset: number | null = 0, joined = "";
  for (let guard = 0; offset !== null && guard < 20; guard++) {
    const page = snap({ maxChars: 10, offset });
    wellFormed(page);
    expect(page.text.returnedChars).toBe(page.text.content.length);
    expect(page.text.nextOffset).toBe(page.text.truncated ? page.text.offset + page.text.content.length : null);
    joined += page.text.content; offset = page.text.nextOffset;
  }
  expect(joined).toBe(original);
});
it("sliceText reports the offset it actually used and always advances", () => {
  const full = "😀😀😀";
  let offset: number | null = 0, joined = "";
  for (let guard = 0; offset !== null && guard < 10; guard++) { const s = sliceText(full, offset, 1); wellFormed(s); joined += s.content; offset = s.nextOffset; }
  expect(joined).toBe(full);
  // An offset inside a pair is pulled back to its start.
  expect(sliceText(full, 1, 4)).toMatchObject({ offset: 0, content: "😀😀", nextOffset: 4 });
});
it("bounds field values, options, context and extracted text without lone surrogates", async () => {
  document.body.innerHTML = `<textarea aria-label="memo"></textarea><select aria-label="pick"><option>${"o".repeat(127)}😀x</option></select>`
    + `<ul><li>${"r".repeat(79)}😀 row <button>Buy</button></li><li>other <button>Buy</button></li></ul>`;
  document.querySelector("textarea")!.value = `${"v".repeat(511)}😀`;
  const result = snap();
  wellFormed(result);
  const ref = result.elements.find(e => e.name === "memo")!.ref;
  const filled: any = await runAction("fill", { ref, text: `${"w".repeat(511)}😀`, generation: 1 });
  expect(filled.verified).toMatchObject({ matches: true, valueTruncated: true }); wellFormed(filled);
  const pressed: any = await runAction("press", { ref, key: "End", generation: 1 });
  wellFormed(pressed);
  const text: any = await extract({ kind: "text", maxChars: 200, offset: 0 });
  wellFormed(text);
  await expect(runAction("select", { ref: result.elements.find(e => e.name === "pick")!.ref, option: `${"z".repeat(127)}😀`, generation: 1 }))
    .rejects.toSatisfy((error: any) => !lone([error.message, error.details]));
});
it("shortens a giant table cell on a character boundary", async () => {
  document.body.innerHTML = `<table><tr><th>h</th></tr><tr><td>${"😀".repeat(999)}</td></tr></table>`;
  const page: any = await extract({ kind: "table", maxChars: 400, offset: 0 });
  expect(page.limits).toContain("table-cells-truncated");
  wellFormed(page);
});
it("query lines are cut around the match on character boundaries", () => {
  document.body.innerHTML = `<p>${"😀".repeat(120)} needle ${"😀".repeat(200)}</p>`;
  const result = snap({ query: "needle" });
  expect(result.text.content).toContain("needle");
  wellFormed(result);
});
it("background tab descriptions and bookmark titles stay well formed", async () => {
  const title = `${"t".repeat(255)}😀`, url = `https://example.test/${"u".repeat(2027)}😀`;
  const tab = { id: 5, windowId: 1, status: "complete", url, title } as chrome.tabs.Tab;
  let created!: (details: any) => void;
  const tracker = trackCreatedTabs({ tabsGet: async () => tab, onTabUpdated: () => () => {}, onTabRemoved: () => () => {}, onCreatedNavigationTarget: fn => { created = fn; return () => {}; } }, 1, 0, new AbortController().signal);
  created({ sourceTabId: 1, sourceFrameId: 0, tabId: 5 });
  const done = await tracker.finish();
  expect(done.openedTabs).toHaveLength(1); wellFormed(done);
  const listed = await readBookmarks({ granted: async () => true, children: async () => [{ id: "1", parentId: "0", title: `${"b".repeat(511)}😀`, url: "https://example.test/" } as any], search: async () => [] }, { action: "list" });
  wellFormed(listed);
});
