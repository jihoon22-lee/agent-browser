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
