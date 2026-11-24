import { runAction } from "../src/content/actions";
import { resetRegistry } from "../src/content/refs";
import { takeSnapshot } from "../src/content/snapshot";

beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = "<div id='host'></div>"; resetRegistry(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function shadowTarget(covered: boolean, nested = false) {
  const host = document.getElementById("host")!;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = nested ? "<div id='nested'></div>" : "<button>Save</button><div>Overlay</div>";
  const innerHost = nested ? root.querySelector("div")! : host;
  const inner = nested ? innerHost.attachShadow({ mode: "open" }) : root;
  if (nested) inner.innerHTML = "<button>Save</button><div>Overlay</div>";
  const button = inner.querySelector("button")!;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ x: 0, y: 0, width: 20, height: 20 }] as unknown as DOMRectList);
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 20, height: 20 } as DOMRect);
  Object.defineProperty(button, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => host });
  Object.defineProperty(root, "elementFromPoint", { configurable: true, value: () => nested ? innerHost : covered ? inner.querySelector("div") : button });
  if (nested) Object.defineProperty(inner, "elementFromPoint", { configurable: true, value: () => covered ? inner.querySelector("div") : button });
  const ref = takeSnapshot({ snapshotId: 21, frameId: 0, maxChars: 100, offset: 0, checkLayout: true }).elements[0]!.ref;
  return { button, ref };
}

it.each([false, true])("clicks an uncovered open shadow target (nested=%s)", async (nested) => {
  const { button, ref } = shadowTarget(false, nested);
  const clicked = vi.fn(); button.addEventListener("click", clicked);
  const result = expect(runAction("click", { ref, generation: 1 })).resolves.toMatchObject({ executed: true });
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(clicked).toHaveBeenCalledTimes(1);
});

it("does not click through an overlay inside the same shadow root", async () => {
  const { button, ref } = shadowTarget(true);
  const clicked = vi.fn(); button.addEventListener("click", clicked);
  await expect(runAction("click", { ref, generation: 1 })).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE", details: { coveredBy: { tag: "div" } } });
  expect(clicked).not.toHaveBeenCalled();
});

it("includes coveredBy.ref when the covering element has a registered ref", async () => {
  document.body.innerHTML = "<button id='target'>Save</button><button id='blocker'>Close</button>";
  const target = document.getElementById("target")!;
  const blocker = document.getElementById("blocker")!;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ x: 0, y: 0, width: 20, height: 20 }] as unknown as DOMRectList);
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 20, height: 20 } as DOMRect);
  Object.defineProperty(target, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => blocker });
  const snap = takeSnapshot({ snapshotId: 22, frameId: 0, maxChars: 200, offset: 0, checkLayout: true });
  const targetRef = snap.elements.find(e => e.name === "Save")!.ref;
  const blockerRef = snap.elements.find(e => e.name === "Close")!.ref;
  await expect(runAction("click", { ref: targetRef, generation: 1 })).rejects.toMatchObject({
    code: "ELEMENT_NOT_INTERACTABLE",
    details: { coveredBy: { tag: "button", ref: blockerRef } },
  });
});

it("reports focused=true inside open shadow DOM, supports horizontal scroll and multi-select deselect", async () => {
  const host = document.getElementById("host")!;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <input id="shadow-in" type="text" value="hello" />
    <select id="multi" multiple>
      <option value="a" selected>Alpha</option>
      <option value="b" selected>Beta</option>
      <option value="c">Gamma</option>
    </select>
    <div id="scroller" style="overflow-x: auto;">Wide</div>
    <div id="editable" contenteditable="true">Initial text</div>
  `;
  const input = root.querySelector<HTMLInputElement>("#shadow-in")!;
  Object.defineProperty(document, "activeElement", { configurable: true, value: host });
  Object.defineProperty(root, "activeElement", { configurable: true, value: input });
  const editable = root.querySelector<HTMLDivElement>("#editable")!;
  Object.defineProperty(editable, "isContentEditable", { configurable: true, value: true });
  const snap = takeSnapshot({ snapshotId: 23, frameId: 0, maxChars: 500, offset: 0, checkLayout: false });
  expect(snap.elements.find(e => e.tag === "input")?.state).toContain("focused");
  const selectEl = snap.elements.find(e => e.tag === "select")!;
  expect(selectEl.value).toBe("Alpha, Beta");

  // Deselect one option on <select multiple> via checked: false
  const deselectPromise = runAction("select", { ref: selectEl.ref, option: "a", checked: false, generation: 1 });
  await vi.advanceTimersByTimeAsync(150);
  const deselectResult = await deselectPromise as { verified: { value: string; selected: string[] } };
  expect(deselectResult.verified.selected).toEqual(["Beta"]);
  expect(deselectResult.verified.value).toBe("b");

  // Empty string fill clears contenteditable
  const editableRef = snap.elements.find(e => e.tag === "div")!.ref;
  const fillPromise = runAction("fill", { ref: editableRef, text: "", generation: 1 });
  await vi.advanceTimersByTimeAsync(150);
  await fillPromise;
  expect(editable.textContent).toBe("");

  // Query matches visible selected option text on <select>
  const queried = takeSnapshot({ snapshotId: 24, frameId: 0, maxChars: 500, offset: 0, checkLayout: false, query: "Beta" });
  expect(queried.elements.some(e => e.tag === "select")).toBe(true);

  // Horizontal scroll (right / left) on shadow container
  const scroller = root.querySelector<HTMLDivElement>("#scroller")!;
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 100 });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 500 });
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, writable: true, value: 0 });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } as DOMRect);
  scroller.scrollBy = ((arg?: ScrollToOptions | number) => {
    const dx = typeof arg === "number" ? arg : arg?.left ?? 0;
    scroller.scrollLeft += dx;
  }) as typeof scroller.scrollBy;
  const scrollRight = await runAction("scroll", { direction: "right", generation: 1 }) as { verified: { scrollLeft: number; scrollWidth: number; target: string } };
  expect(scrollRight.verified.target).toBe("region");
  expect(scrollRight.verified.scrollLeft).toBeGreaterThan(0);
  expect(scrollRight.verified.scrollWidth).toBe(500);
  const scrollLeft = await runAction("scroll", { direction: "left", generation: 1 }) as { verified: { scrollLeft: number } };
  expect(scrollLeft.verified.scrollLeft).toBe(0);
});
