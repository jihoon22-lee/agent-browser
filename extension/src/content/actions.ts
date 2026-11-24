import { highlight } from "./highlight";
import { clipText } from "./text";
import { assertTrustedFallback, requestTrusted, trustedFrame, trustedDetails } from "./trusted";
import { ProtocolError } from "../protocol/errors";
import { accessibleName, composedParent, deepActiveElement, isDisabled, isInteractive, isRendered, walkDeep } from "./dom";
import { findRef, resolveRef } from "./refs";
import { waitFor, textConditions } from "./wait";
import { extract } from "./extract";
import { observePage } from "./observe";
import { INPUT_TEXT, keyOf, preparePress, pressKey } from "./keyboard";
import { cancellationError, cancelCommands, checkCancelled, withCommandCancellation, type CommandScope } from "./cancellation";

export function cancelUpTo(generation: number) { cancelCommands({ generation }); }

type P = Record<string, unknown> & CommandScope;
const hasLayout = () => document.documentElement.getClientRects().length > 0;
function clickPoint(el:Element) {
  // Inline links can wrap into disjoint rectangles; their union's center may
  // be whitespace. Choose an actual visible fragment for hit testing and input.
  const r=[...el.getClientRects()].find(r=>r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight)
    ?? el.getBoundingClientRect();
  return {clientX:(Math.max(0,r.left)+Math.min(innerWidth,r.left+r.width))/2,
    clientY:(Math.max(0,r.top)+Math.min(innerHeight,r.top+r.height))/2};
}

type Point = { clientX: number; clientY: number };
/** Several points per visible fragment: a badge or sticky bar over the center must not block the click. */
function candidatePoints(el: Element): Point[] {
  const rects = [...el.getClientRects()].filter(r => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight);
  const points: Point[] = [];
  for (const r of rects.length ? rects : [el.getBoundingClientRect()]) {
    const left = Math.max(0, r.left), right = Math.min(innerWidth, r.left + r.width), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.top + r.height);
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]] as const) points.push({ clientX: left + (right - left) * fx, clientY: top + (bottom - top) * fy });
  }
  return points;
}
function topAt({ clientX: x, clientY: y }: Point): Element | null {
  let top = document.elementFromPoint(x, y);
  // Document hit testing retargets shadow children to their host. Descend each
  // open root so an overlay inside that same root still blocks the click.
  const visited = new Set<Element>();
  while (top?.shadowRoot && !visited.has(top)) {
    visited.add(top);
    const inner: Element | null = top.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === top) break;
    top = inner;
  }
  return top;
}
function reaches(top: Element | null, el: Element): boolean {
  let hit: Element | null = top;
  while (hit && hit !== el) hit = composedParent(hit);
  if (hit) return true;
  // A visually hidden native control is commonly covered by its own styled label.
  const label = top?.closest("label");
  return !!label && "labels" in el && [...((el as HTMLInputElement).labels ?? [])].includes(label);
}

/** Whether a hit inside `el` lands on `el` itself rather than on a separate control nested in it (a
 * favourite button in a link card). That control has its own ref; clicking it instead would press
 * something the agent did not name. */
function ownHit(top: Element | null, el: Element): boolean {
  for (let hit = top; hit && hit !== el; hit = composedParent(hit)) if (isInteractive(hit)) return false;
  return true;
}
const inViewport = (point: Point) => point.clientX >= 0 && point.clientY >= 0 && point.clientX < innerWidth && point.clientY < innerHeight;
/** A reachable point of the element in viewport coordinates, scrolling it into view when needed.
 * With `allowScroll` false the page is left where it is: the caller holds coordinates of another
 * element that a scroll would invalidate. */
function assertInteractable(el: Element, allowScroll = true): Point | undefined {
  if (!isRendered(el, { checkLayout: hasLayout() }) || isDisabled(el)) {
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el) || el.tagName} is hidden or disabled.`);
  }
  if (!hasLayout()) return undefined;
  // Preserve an already usable position instead of recentering every field/button.
  const pick = (points: Point[], visible: (point: Point) => boolean) => {
    const reachable = points.filter(point => visible(point) && reaches(topAt(point), el));
    return reachable.find(point => ownHit(topAt(point), el)) ?? reachable[0];
  };
  const usable = pick(candidatePoints(el), inViewport);
  if (usable) return usable;
  if (!allowScroll) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el) || el.tagName} cannot be reached without scrolling the page again.`);
  // "instant" defeats CSS smooth scrolling, so hit testing uses the new position.
  (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  let points = candidatePoints(el);
  const scrolled = pick(points, () => true);
  if (scrolled) return scrolled;
  // "nearest" stops at the viewport edge, which a fixed header or footer may cover: try the middle once.
  (el as HTMLElement).scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  points = candidatePoints(el);
  const centred = pick(points, () => true);
  if (centred) return centred;
  const top = points[0] ? topAt(points[0]) : null;
  if (top) {
    const coveringRef = findRef(top);
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el)} is covered by another element.`, "never",
      { coveredBy: { tag: top.tagName.toLowerCase(), name: accessibleName(top), ...(coveringRef ? { ref: coveringRef } : {}) } });
  }
  // Nothing is hit outside the viewport: the element could not be scrolled into it (fixed or
  // clipped off screen). A visually hidden native control is used through its label instead.
  const labelled = "labels" in el && ((el as HTMLInputElement).labels?.length ?? 0) > 0;
  if (points[0] && !inViewport(points[0]) && !labelled)
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el) || el.tagName} is outside the viewport and cannot be scrolled into view.`);
  return points[0];
}

/** What a click can change without a DOM mutation: a checkbox or radio toggled through its `checked`
 * property (directly or through its label), a select's value, or a text field taking the caret.
 * Focus landing on a clicked button is a by-product, not an effect. */
function quietState(el: Element): unknown[] {
  const controls: Element[] = [el, ...Array.from(el.querySelectorAll("input,select")).slice(0, 20)];
  const labelled = el instanceof HTMLLabelElement ? el.control : el.closest("label")?.control;
  if (labelled) controls.push(labelled);
  const active = deepActiveElement(document);
  const typing = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && !["button", "submit", "reset", "checkbox", "radio", "image", "file", "color", "range"].includes(active.type)) || (active as HTMLElement | null)?.isContentEditable;
  return [typing ? active : null, ...controls.map(control => control instanceof HTMLInputElement ? `${control.checked}|${control.value}` : control instanceof HTMLSelectElement ? control.value : "")];
}

/** Focus the nearest focusable ancestor, as a real pointer press does before mouseup and click. */
function focusFromPointer(el: Element) {
  for (let node: Element | null = el; node; node = composedParent(node)) {
    if (!(node instanceof HTMLElement) || node.tabIndex < 0 || isDisabled(node)) continue;
    if (activeIn(node) !== node) node.focus({ preventScroll: true });
    return;
  }
}
const activeIn = (el: Element) => (el.getRootNode() as Document | ShadowRoot).activeElement;

type Changes = Promise<{ urlChanged: boolean; domChanged: boolean }> & { delivered(): void };
/** Watches the page from now until `ms` after the input was delivered. DOM input is delivered at
 * once. Trusted input makes a round trip through the debugger first: with `inTransit` the window
 * is counted from `delivered()`, so a slow round trip cannot use it up before the page reacts. */
function observeChanges(ms: number, signal: AbortSignal, inTransit = false): Changes {
  const startUrl = location.href;
  let mutated = false, delivered = () => {};
  const changes = new Promise<{ urlChanged: boolean; domChanged: boolean }>((resolve, reject) => {
    const mo = observePage(() => { mutated = true; mo.disconnect(); });
    let timer: ReturnType<typeof setTimeout> | undefined, finished = false;
    const done = () => { finished = true; mo.disconnect(); clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { done(); reject(cancellationError(true)); };
    delivered = () => {
      if (finished || timer !== undefined) return;
      timer = setTimeout(() => { if (!mutated) mutated = mo.refresh(); done(); resolve({ urlChanged: location.href !== startUrl, domChanged: mutated }); }, ms);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else if (!inTransit) delivered();
  });
  return Object.assign(changes, { delivered: () => delivered() });
}

function verificationValue(value: string) {
  return { value: clipText(value, 512), ...(value.length > 512 ? { valueTruncated: true } : {}) };
}

const EDITOR_BLOCK = "p,div,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr";
/** An editor's text with its line structure: innerText in a browser, a block walk without layout. */
function editorText(host: HTMLElement): string {
  if (typeof host.innerText === "string") return host.innerText;
  let text = "";
  const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue ?? "";
    else if ((node as Element).tagName === "BR" || ((node as Element).matches(EDITOR_BLOCK) && text && !text.endsWith("\n"))) text += "\n";
  }
  return text;
}
/** Lines as a person reads them: editors add blank lines between paragraphs and use no-break spaces. */
const shownLines = (value: string) => value.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/\u00a0/g, " ").trimEnd()).filter(Boolean).join("\n");

function nativeSet(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

function focusForFill(el: HTMLElement, p: P, signal: AbortSignal) {
  el.focus();
  checkCancelled(p, signal);
  // Focus handlers can recycle a record or make the field unavailable before
  // the value setter runs. Post-input verification would be too late.
  resolveRef(String(p.ref), false, 'dispatch');
  assertInteractable(el);
}

/** Let queued application updates and a visible render run before confirming a value. A hidden
 * tab must not depend on rAF firing. This is a bounded value observation, not server acknowledgement. */
async function afterInput(ref: string, signal: AbortSignal) {
  await new Promise<void>((resolve,reject) => {
    let frame = 0;
    const done = () => { clearTimeout(timer); if(frame)cancelAnimationFrame(frame); signal.removeEventListener('abort',abort); resolve(); };
    const abort = () => { clearTimeout(timer); if(frame)cancelAnimationFrame(frame); signal.removeEventListener('abort',abort); reject(cancellationError(true)); };
    const visible = hasLayout() && document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function';
    const timer = setTimeout(done,visible ? 40 : 0);
    if(visible)frame=requestAnimationFrame(()=>setTimeout(done,0));
    signal.addEventListener('abort',abort,{once:true}); if(signal.aborted)abort();
  });
  // Handlers can update ordinary validation/price text in the same record. The
  // dispatched control must remain connected with the same identity and record key,
  // but this post-input value check does not authorize a new write through an old ref.
  try { resolveRef(ref,false,'target'); }
  catch { throw new ProtocolError('EXECUTION_UNKNOWN','The input was delivered, but its target changed before the value could be confirmed. Inspect the page before continuing.','unsafe'); }
}

export async function runAction(method: string, p: P, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return withCommandCancellation(p, (activeSignal) => executeAction(method, p, activeSignal), signal);
}

/** Drag ref onto toRef: trusted mouse input when allowed and the source is not an HTML5 drag source,
 * otherwise pointer events followed, for HTML5 sources, by a drag sequence sharing one DataTransfer. */
async function dragOnto(el: Element, target: Element, p: P, signal: AbortSignal): Promise<Record<string, unknown>> {
  assertInteractable(el);
  const to = assertInteractable(target) ?? clickPoint(target);
  // Bringing the target into view may have moved the source: read its position again, without
  // scrolling. Two ends that cannot be on screen together fail here, before any input.
  const from = assertInteractable(el, false) ?? clickPoint(el);
  // The browser drags the nearest draggable ancestor (a card holding the link the ref names).
  const source = el.closest('[draggable=true], a[href]:not([draggable=false]), img:not([draggable=false])');
  const html5 = source !== null;
  const unmark = highlight(el);
  const viaDebugger = p.trusted === true && (trustedFrame() || p.trustedFrames === true) && !html5;
  const changes = observeChanges(p.waitFor ? 0 : 500, signal, viaDebugger);
  void changes.then(unmark, unmark);
  void changes.catch(() => {});
  let trustedReason: string | undefined;
  if (viaDebugger) {
    const answer = await requestTrusted(String(p.requestId ?? ""), "drag", {ref:p.ref,toRef:p.toRef, x: from.clientX, y: from.clientY, toX: to.clientX, toY: to.clientY }).finally(changes.delivered);
    if (answer.ok) return { executed: true, verified: { ...await changes, mode: "drag", trusted: true, ...trustedDetails(answer), ...(answer.dialog ? { dialog: answer.dialog } : {}) } };
    assertTrustedFallback(answer, p, signal);
    trustedReason = answer.reason;
  }
  checkCancelled(p, signal);
  const pointer = (on: Element, type: string, at: Point, down: boolean) =>
    on.dispatchEvent(new (type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent)(type, {
      ...at, bubbles: true, cancelable: true, composed: true, button: 0, buttons: down ? 1 : 0, detail: type.endsWith("move") ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: down ? 0.5 : 0 }));
  const middle = { clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2 };
  pointer(el, "pointerdown", from, true); pointer(el, "mousedown", from, true);
  pointer(el, "pointermove", middle, true); pointer(el, "mousemove", middle, true);
  pointer(target, "pointermove", to, true); pointer(target, "mousemove", to, true);
  pointer(target, "pointerup", to, false); pointer(target, "mouseup", to, false);
  let dropped = false;
  if (html5) {
    const dataTransfer = typeof DataTransfer !== "undefined" ? new DataTransfer() : null;
    const drag = (on: Element, type: string, at: Point) => {
      const init = { ...at, bubbles: true, cancelable: true, composed: true, dataTransfer };
      const event = typeof DragEvent !== "undefined" ? new DragEvent(type, init) : Object.assign(new MouseEvent(type, init), { dataTransfer });
      return on.dispatchEvent(event);
    };
    // A cancelled dragstart means the page refused the drag; do not drop.
    if (drag(source!, "dragstart", from)) {
      drag(target, "dragenter", to);
      dropped = !drag(target, "dragover", to);
      if (dropped) drag(target, "drop", to);
      drag(source!, "dragend", to);
    }
  }
  return { executed: true, verified: { ...await changes, mode: "drag", ...(html5 ? { dropped } : {}), ...(trustedReason ? { trusted: false, trustedReason } : {}) } };
}

async function executeAction(method: string, p: P, signal: AbortSignal): Promise<Record<string, unknown>> {
  switch (method) {
    case "link": {
      const el=resolveRef(String(p.ref));
      if (!(el instanceof HTMLAnchorElement) || !el.hasAttribute('href') || el.hasAttribute('download'))
        throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','newTab requires a normal anchor without download; JavaScript buttons are not guessed.');
      if (!['http:','https:'].includes(new URL(el.href).protocol)) throw new ProtocolError('UNSUPPORTED_PAGE','Only HTTP(S) links can open in a new tab.');
      return {url:el.href};
    }
    case "close-check": {
      // Preserve edited controls even on sites that forgot beforeunload. A custom
      // editor cannot be certified clean, so leave it open as well.
      const controls: Element[] = [];
      walkDeep(document, el => { if (el.matches('input,textarea,select,[contenteditable]')) controls.push(el); });
      const dirty = controls.some(el => {
        if (el instanceof HTMLInputElement) {
          if (['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) return false;
          if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
          if (el.type === 'file') return (el.files?.length ?? 0) > 0;
          // Let the browser normalize the authored value with the same type and
          // constraints, without copying the live input's dirty value flag.
          const baseline = document.createElement('input');
          for (const attr of el.attributes) baseline.setAttribute(attr.name, attr.value);
          baseline.value = el.getAttribute('value') ?? '';
          return el.value !== baseline.value;
        }
        if (el instanceof HTMLTextAreaElement) return el.value !== el.defaultValue;
        if (el instanceof HTMLSelectElement) {
          const options = Array.from(el.options);
          if (el.multiple) return options.some(o => o.selected !== o.defaultSelected);
          let index = options.map(o => o.defaultSelected).lastIndexOf(true);
          if (index < 0 && el.size <= 1) index = options.findIndex(o => !o.disabled && !o.closest('optgroup[disabled]'));
          return el.selectedIndex !== index;
        }
        return (el as HTMLElement).isContentEditable;
      });
      if (dirty) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'Edited form controls or an editable region may contain unsaved data; preserve this tab.');
      return {executed: false};
    }
    case "click": {
      const el = resolveRef(String(p.ref));
      const mode = String(p.mode ?? "click");
      if (mode === "drag") return dragOnto(el, resolveRef(String(p.toRef)), p, signal);
      if (!["click", "double", "right", "hover"].includes(mode)) throw new ProtocolError("INVALID_PARAMS", `Unsupported click mode ${mode}.`);
      const modeNote = mode === "click" ? {} : { mode };
      const point = assertInteractable(el) ?? clickPoint(el);
      const unmark = highlight(el);
      const viaDebugger = p.trusted === true && (trustedFrame() || p.trustedFrames === true);
      const changes = observeChanges(p.waitFor ? 0 : 500, signal, viaDebugger);
      void changes.then(unmark, unmark);
      let trustedReason: string | undefined;
      if (viaDebugger) {
        const answer = await requestTrusted(String(p.requestId ?? ""), "click", { ref:p.ref, x: point.clientX, y: point.clientY, ...modeNote }).finally(changes.delivered);
        if (answer.ok) return { executed: true, verified: { ...await changes, ...modeNote, trusted: true, ...trustedDetails(answer), ...(answer.dialog ? { dialog: answer.dialog } : {}) } };
        assertTrustedFallback(answer, p, signal);
        if (!answer.ok) trustedReason = answer.reason;
      }
      // Cancellation may arrive while the background decides whether it can
      // deliver trusted input. Never revive that command as synthetic input.
      checkCancelled(p, signal);
      const base={...point,bubbles:true,cancelable:true,composed:true,button:0,detail:1};
      // A rejected pre-click check must not leave an unhandled observation when
      // the command is cancelled. The observer itself is bounded to 500ms.
      void changes.catch(() => {});
      // A real pointer event targets the deepest element under the pointer and bubbles to the ref.
      // Pages listen on that inner element (a span in a labelled wrapper) or read event.target (a td).
      // Never into a separate control nested in the ref: that is another ref.
      const under = (at: Point = point): Element => { const top = hasLayout() ? topAt(at) : null; return top && top !== el && el.contains(top) && ownHit(top, el) ? top : el; };
      const pointer = (type: string, init: Record<string, unknown>) =>
        under().dispatchEvent(new (type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent)(type, {...base,pointerId:1,pointerType:'mouse',isPrimary:true,...init}));
      // Nothing observable happened: say so instead of leaving a bare "executed". (With waitFor the
      // caller's own condition decides, and the observation window is not kept open.)
      const quietBefore = quietState(el);
      const outcome = async () => {
        const seen = await changes;
        const quiet = quietState(el).every((value, index) => value === quietBefore[index]);
        return !p.waitFor && quiet && seen && seen.domChanged === false && seen.urlChanged === false ? { ...seen, noEffect: true } : seen;
      };
      if (mode === "hover") {
        // enter events do not bubble: like a pointer arriving from outside, enter each ancestor, outermost first.
        const chain: Element[] = [];
        for (let node: Element | null = el; node; node = node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)) chain.unshift(node);
        for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
          if (!type.endsWith("enter")) { pointer(type, { buttons: 0, detail: 0 }); continue; }
          for (const node of chain) node.dispatchEvent(new (type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent)(type, {...base,buttons:0,detail:0,bubbles:false,pointerId:1,pointerType:'mouse',isPrimary:true}));
        }
        return { executed: true, verified: { ...await outcome(), ...modeNote, ...(trustedReason ? { trusted: false, trustedReason } : {}) } };
      }
      const button = mode === "right" ? 2 : 0;
      const checkTarget = (): Point => {
        try {
          resolveRef(String(p.ref), false, 'dispatch');
          return assertInteractable(el) ?? clickPoint(el);
        } catch (error) {
          throw new ProtocolError('EXECUTION_UNKNOWN',
            'Pointer events were delivered, but the target changed before the next event. Inspect the page before continuing.',
            'unsafe', { cause: error instanceof ProtocolError ? error.code : 'INTERNAL' });
        }
      };
      const press = (detail: number) => {
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
          const down=type.endsWith('down');
          const accepted = pointer(type, { button, buttons: down ? (button === 2 ? 2 : 1) : 0, pressure: down ? 0.5 : 0, detail });
          // The browser moves focus as mousedown's default action; a page that cancels it keeps its focus.
          if (type === "mousedown" && accepted) focusFromPointer(el);
          checkTarget();
        }
      };
      press(1);
      const finalPoint = checkTarget();
      // Retain native activation and viewport coordinates after the final check.
      // This is still untrusted input.
      if (mode === "right") {
        under(finalPoint).dispatchEvent(new MouseEvent('contextmenu',{...base,...finalPoint,button:2,buttons:0}));
      } else {
        under(finalPoint).dispatchEvent(new MouseEvent('click',{...base,...finalPoint,buttons:0}));
        if (mode === "double") {
          checkTarget();
          press(2);
          let again = checkTarget();
          under(again).dispatchEvent(new MouseEvent('click',{...base,...again,buttons:0,detail:2}));
          again = checkTarget();
          under(again).dispatchEvent(new MouseEvent('dblclick',{...base,...again,buttons:0,detail:2}));
        }
      }
      return { executed: true, verified: { ...await outcome(), ...modeNote, ...(trustedReason ? { trusted: false, trustedReason } : {}) } };
    }
    case "fill": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      const text = String(p.text ?? "");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el instanceof HTMLInputElement && el.type === 'file') throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','File upload is not supported by browser_fill; it cannot read a local path or choose a file.');
        if (el instanceof HTMLInputElement && !INPUT_TEXT.has(el.type)) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', el.type === 'checkbox' || el.type === 'radio' ? 'browser_fill only replaces text. Use browser_select with checked for this control.' : 'browser_fill only replaces text. Use browser_click for buttons.');
        if (el.readOnly) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The field is read-only.");
        focusForFill(el, p, signal);
        if (el.readOnly) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The field became read-only during focus.");
        let usedTrusted=false, trustedResult:ReturnType<typeof trustedDetails>={};
        if(p.trusted===true && p.trustedFrames===true && (el instanceof HTMLTextAreaElement || ['text','search','tel','url','password'].includes(el.type))) {
          el.select();
          const answer=await requestTrusted(String(p.requestId??''),'text',{ref:p.ref,text});
          if(answer.ok){usedTrusted=true;trustedResult=trustedDetails(answer);}else assertTrustedFallback(answer,p,signal);
        }
        if(!usedTrusted){nativeSet(el, text);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await afterInput(String(p.ref),signal);
        const value = el.value;
        const isPassword = el instanceof HTMLInputElement && el.type === "password";
        return { executed: true, verified: isPassword ? { matches: value === text, trusted:usedTrusted,...trustedResult } : { ...verificationValue(value), matches: value === text, trusted:usedTrusted,...trustedResult } };
      }
      if ((el as HTMLElement).isContentEditable) {
        const host = el as HTMLElement, doc = host.ownerDocument;
        focusForFill(host, p, signal);
        if (!host.isContentEditable) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'The editor became read-only during focus.');
        const range = doc.createRange(); range.selectNodeContents(host);
        const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        // Editors such as ProseMirror, Draft or Slate update their own model from insertText.
        let usedTrusted=false, trustedResult:ReturnType<typeof trustedDetails>={};
        if(p.trusted===true&&p.trustedFrames===true){const answer=await requestTrusted(String(p.requestId??''),'text',{ref:p.ref,text});if(answer.ok){usedTrusted=true;trustedResult=trustedDetails(answer);}else assertTrustedFallback(answer,p,signal);}
        const inserted = usedTrusted || (typeof doc.execCommand === "function" && (text === "" ? doc.execCommand("delete", false) : doc.execCommand("insertText", false, text)));
        if (!inserted) {
          host.textContent = text;
          host.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }));
        }
        await afterInput(String(p.ref),signal);
        // An editor renders each line as its own block, which textContent runs together.
        const multiline = /[\r\n]/.test(text);
        const value = multiline ? editorText(host) : host.textContent ?? "";
        return { executed: true, verified: { ...verificationValue(value), matches: value === text || host.textContent === text || (multiline && shownLines(value) === shownLines(text)), method: inserted ? "insertText" : "replace", trusted:usedTrusted,...trustedResult } };
      }
      throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "browser_fill only works on text inputs, textareas and editable areas.");
    }
    case "select": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      if (el instanceof HTMLSelectElement) {
        // Without this, a call that forgot `option` selected the empty placeholder and reported a match.
        if (p.option === undefined || p.option === null) throw new ProtocolError("INVALID_PARAMS", "browser_select on a <select> needs option (its value or visible label).");
        const want = String(p.option);
        const opt = [...el.options].find((o) => o.value === want) ?? [...el.options].find((o) => o.text.trim() === want);
        if (!opt) {
          const labels = [...el.options].slice(0, 20).map(option => option.text.trim());
          throw new ProtocolError("ELEMENT_NOT_FOUND", `No option "${clipText(want, 128)}${want.length > 128 ? "…" : ""}".`, "never", {
            options: labels.map(label => clipText(label, 128)), optionsTotal: el.options.length,
            optionsTruncated: el.options.length > labels.length || labels.some(label => label.length > 128),
          });
        }
        if (opt.disabled || (opt.parentElement instanceof HTMLOptGroupElement && opt.parentElement.disabled)) {
          throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The requested option is disabled.");
        }
        // Select or deselect the option itself: assigning value would pick the first option sharing that
        // value, and would clear the other choices of a multiple select.
        const selectWant = el.multiple && typeof p.checked === "boolean" ? p.checked : true;
        if (el.multiple) opt.selected = selectWant; else el.selectedIndex = opt.index;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        await afterInput(String(p.ref),signal);
        const matches = el.multiple ? opt.selected === selectWant : el.selectedOptions[0] === opt;
        const shown = el.multiple && opt.selected ? opt : el.selectedOptions[0];
        const label = shown?.text.trim() ?? "";
        const selectedLabels = el.multiple ? [...el.selectedOptions].slice(0, 20).map(o => clipText(o.text.trim(), 128)) : undefined;
        return { executed: true, verified: { ...verificationValue(shown?.value ?? el.value), matches, label: clipText(label, 512), ...(label.length > 512 ? { labelTruncated: true } : {}), ...(selectedLabels ? { selected: selectedLabels, ...(el.selectedOptions.length > 20 ? { selectedTruncated: true } : {}) } : {}) } };
      }
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const want = p.checked ?? true;
        if (typeof want !== "boolean") throw new ProtocolError("INVALID_PARAMS", "checked must be a boolean.");
        if (el.type === "radio" && el.checked && !want) throw new ProtocolError("INVALID_PARAMS", "A selected radio cannot be cleared by clicking it. Select another radio in the group.");
        const changed = el.checked !== want;
        if (changed) el.click();
        if (changed) await afterInput(String(p.ref),signal);
        if (el.checked !== want) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The page did not accept the requested checked state.", "never", { executed: changed, checked: el.checked });
        return { executed: changed, verified: { checked: el.checked, matches: true } };
      }
      throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "browser_select works on select, checkbox and radio elements.");
    }
    case "press": {
      if (p.trusted === true && (trustedFrame() || p.trustedFrames === true)) {
        // The same checks as a DOM key press run first: a real key must not reach another element.
        preparePress(p, assertInteractable);
        const changes = observeChanges(p.waitFor ? 0 : 500, signal, true);
        void changes.catch(() => {});
        const { key, modifiers } = keyOf(p);
        const answer = await requestTrusted(String(p.requestId ?? ""), "key", {ref:p.ref, key, ...(modifiers.length ? { modifiers } : {}) }).finally(changes.delivered);
        // The browser itself performs the key's default action; nothing is emulated here.
        if (answer.ok) return { executed: true, verified: { key, ...(modifiers.length ? { modifiers } : {}), trusted: true, ...trustedDetails(answer), ...await changes, ...(answer.dialog ? { dialog: answer.dialog } : {}) } };
        // Do not wait 500ms on an undispatched fallback before running the synthetic press.
        assertTrustedFallback(answer, p, signal);
        const fallbackChanges = observeChanges(p.waitFor ? 0 : 500, signal);
        void fallbackChanges.catch(() => {});
        const fallback = pressKey(p, assertInteractable) as { executed: boolean; verified: Record<string, unknown> };
        return { ...fallback, verified: { ...fallback.verified, ...await fallbackChanges, trusted: false, trustedReason: answer.ok ? "" : answer.reason } };
      }
      const changes = observeChanges(p.waitFor ? 0 : 500, signal);
      void changes.catch(() => {});
      const result = pressKey(p, assertInteractable) as { executed: boolean; verified: Record<string, unknown> };
      return { ...result, verified: { ...result.verified, ...await changes } };
    }
    case "upload": return upload(p, signal);
    case "scroll": return scroll(p);
    case "wait": return waitFor(p, signal);
    case "conditions": return {conditions:textConditions(p)};
    case "extract": return extract(p);
    default: throw new ProtocolError("INVALID_PARAMS", `Unknown action ${method}`);
  }
}

/** The file input a ref stands for: itself, its label's control, the only one inside it, or the only one in its form. */
function fileInputFor(el: Element): HTMLInputElement | null {
  const file = (x: unknown): x is HTMLInputElement => x instanceof HTMLInputElement && x.type === 'file';
  if (el instanceof HTMLInputElement) return file(el) ? el : null;
  if (el instanceof HTMLLabelElement) return file(el.control) ? el.control : null;
  const inside = [...el.querySelectorAll('input[type=file]')];
  if (inside.length) return inside.length === 1 ? inside[0] as HTMLInputElement : null;
  const label = el.closest('label');
  if (label && file(label.control)) return label.control;
  const form = el.closest('form') ?? ((el as HTMLButtonElement).form ?? null);
  const inForm = form ? [...form.querySelectorAll('input[type=file]')] : [];
  return inForm.length === 1 ? inForm[0] as HTMLInputElement : null;
}
function accepts(input: HTMLInputElement, name: string, mime: string) {
  const tokens = input.accept.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const lower = name.toLowerCase(), type = mime.split(';')[0]!.trim().toLowerCase();
  return !tokens.length || tokens.some(t => t === '*/*' || (t.startsWith('.') ? lower.endsWith(t) : t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : t === type));
}
/** Puts one attached file (bytes from the background, never a local path) into the input and fires its events. */
async function upload(p: P, signal: AbortSignal) {
  const el = resolveRef(String(p.ref));
  assertInteractable(el);
  const input = fileInputFor(el);
  if (!input) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'No single file input belongs to this ref. Use the file input, its label, or a button in a form with one file input.');
  if (input.disabled) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', 'The file input is disabled.');
  const name = String(p.name), mime = String(p.mime ?? '');
  if (!accepts(input, name, mime)) throw new ProtocolError('ELEMENT_NOT_INTERACTABLE', `This file input accepts ${clipText(input.accept, 120)}; ${name} does not match.`);
  const dataUrl = String(p.dataUrl), comma = dataUrl.indexOf(','), body = dataUrl.slice(comma + 1);
  const bytes = dataUrl.slice(0, comma).endsWith(';base64') ? Uint8Array.from(atob(body), c => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
  const file = new File([bytes], name, { type: mime });
  // A change handler may draw a preview or submit; report it like a click so a snapshot follows.
  const changes = observeChanges(500, signal);
  void changes.catch(() => {});
  const transfer = new DataTransfer();
  // A multiple input keeps what it already holds; a single one is replaced.
  if (input.multiple) for (const kept of Array.from(input.files ?? [])) transfer.items.add(kept);
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const files = Array.from(input.files ?? []).map(f => f.name);
  return { executed: true, verified: { files, size: file.size, ...await changes } };
}

/** Whether the element scrolls up and down. A horizontal carousel computes overflow-y:auto too and often
 * overflows by a few pixels (a hidden scroll bar); that is not a vertical scroller. The body scrolls
 * on its own only when the root's overflow is not visible; otherwise its overflow is the viewport's. */
const scrollsVertically = (el: Element) => {
  const extra = el.scrollHeight - el.clientHeight;
  if (extra <= 1) return false;
  const style = getComputedStyle(el);
  if (!/auto|scroll|overlay/.test(style.overflowY)) return false;
  if (el === document.body && getComputedStyle(document.documentElement).overflowY === "visible") return false;
  return !(/auto|scroll|overlay/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && extra < 32);
};
const scrollsHorizontally = (el: Element) => {
  const extra = el.scrollWidth - el.clientWidth;
  if (extra <= 1) return false;
  const style = getComputedStyle(el);
  if (!/auto|scroll|overlay/.test(style.overflowX)) return false;
  if (el === document.body && getComputedStyle(document.documentElement).overflowX === "visible") return false;
  return true;
};
const docCanScroll = (doc: HTMLElement, horizontal: boolean) => {
  const overflows = horizontal ? doc.scrollWidth > doc.clientWidth + 1 : doc.scrollHeight > doc.clientHeight + 1;
  if (!overflows) return false;
  const ov = horizontal ? getComputedStyle(doc).overflowX : getComputedStyle(doc).overflowY;
  return !/hidden|clip/.test(ov);
};
/** What can actually move: the ref (or its nearest scrollable ancestor), the document, or — when the
 * document itself cannot scroll, as in an app shell — the largest scrollable area on screen. */
function scrollTarget(p: P, horizontal = false): { el: HTMLElement; target: "document" | "ancestor" | "region" } {
  const doc = (document.scrollingElement ?? document.documentElement) as HTMLElement;
  const canScroll = horizontal ? scrollsHorizontally : scrollsVertically;
  const docOverflows = docCanScroll(doc, horizontal);
  if (p.ref) {
    const start = resolveRef(String(p.ref));
    if (canScroll(start)) return { el: start as HTMLElement, target: "region" };
    for (let node = composedParent(start); node && node !== document.body && node !== document.documentElement; node = composedParent(node))
      if (canScroll(node)) return { el: node as HTMLElement, target: "ancestor" };
    return { el: pageScroller(doc, horizontal), target: "document" };
  }
  if (docOverflows) return { el: doc, target: "document" };
  if (pageScroller(doc, horizontal) !== doc) return { el: document.body, target: "document" };
  let best: HTMLElement | null = null, bestArea = 0, inspected = 0;
  walkDeep(document, el => {
    if (inspected >= 5000 || !(el instanceof HTMLElement) || el === document.body || el === document.documentElement) return;
    inspected++;
    if (!canScroll(el)) return;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (area > bestArea) { best = el; bestArea = area; }
  });
  return best ? { el: best, target: "region" } : { el: doc, target: "document" };
}
/** The element that scrolls the page: the document, or the body when the root is overflow:hidden and
 * the body holds the scroll bar. */
const pageScroller = (doc: HTMLElement, horizontal = false): HTMLElement =>
  docCanScroll(doc, horizontal) || !document.body || !(horizontal ? scrollsHorizontally : scrollsVertically)(document.body) ? doc : document.body;
function scroll(p: P) {
  const horizontal = p.direction === "left" || p.direction === "right";
  const { el, target } = scrollTarget(p, horizontal);
  if (horizontal) {
    const before = el.scrollLeft, page = el.clientWidth * 0.8;
    if (p.direction === "left") el.scrollBy({ left: -page, behavior: 'instant' });
    else el.scrollBy({ left: page, behavior: 'instant' });
    return Promise.resolve({ executed: true, verified: { scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, atStart: el.scrollLeft <= 0, atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1, moved: el.scrollLeft !== before, target } });
  }
  const before = el.scrollTop;
  const page = el.clientHeight * 0.8;
  switch (p.direction) {
    case "up": el.scrollBy({ top: -page, behavior: 'instant' }); break;
    case "down": el.scrollBy({ top: page, behavior: 'instant' }); break;
    case "top": el.scrollTo({ top: 0, behavior: 'instant' }); break;
    case "bottom": el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); break;
    default: throw new ProtocolError("INVALID_PARAMS", "direction must be up, down, top, bottom, left or right");
  }
  // `moved:false` with atEnd means the end was already reached, not that more content is hidden.
  return Promise.resolve({ executed: true, verified: { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, atStart:el.scrollTop<=0, atEnd:el.scrollTop+el.clientHeight>=el.scrollHeight-1, moved: el.scrollTop !== before, target } });
}
