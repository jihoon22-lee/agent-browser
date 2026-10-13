import { ProtocolError } from "../protocol/errors";
import { accessibleName, isRendered, walkDeep } from "./dom";
import { resolveRef } from "./refs";
import { waitFor } from "./wait";
import { extract } from "./extract";
import { observePage } from "./observe";
import { pressKey } from "./keyboard";
import { cancellationError, cancelCommands, withCommandCancellation, type CommandScope } from "./cancellation";

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

function assertInteractable(el: Element) {
  if (!isRendered(el, { checkLayout: hasLayout() }) || el.matches(":disabled") || el.closest("[inert]")) {
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el) || el.tagName} is hidden or disabled.`);
  }
  if (!hasLayout()) return;
  (el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
  const {clientX:x,clientY:y}=clickPoint(el);
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
  let hit: Element | null = top;
  while (hit && hit !== el) hit = hit.parentElement ?? ((hit.getRootNode() as ShadowRoot).host ?? null);
  if (top && !hit) {
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el)} is covered by another element.`, "never",
      { coveredBy: { tag: top.tagName.toLowerCase(), name: accessibleName(top) } });
  }
}

function observeChanges(ms: number, signal: AbortSignal): Promise<{ urlChanged: boolean; domChanged: boolean }> {
  const startUrl = location.href;
  let mutated = false;
  return new Promise((resolve, reject) => {
    const mo = observePage(() => { mutated = true; });
    const done = () => { mo.disconnect(); clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { done(); reject(cancellationError(true)); };
    const timer = setTimeout(() => { mutated = mo.refresh() || mutated; done(); resolve({ urlChanged: location.href !== startUrl, domChanged: mutated }); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function verificationValue(value: string) {
  return { value: value.slice(0, 512), ...(value.length > 512 ? { valueTruncated: true } : {}) };
}

function nativeSet(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

export async function runAction(method: string, p: P, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return withCommandCancellation(p, (activeSignal) => executeAction(method, p, activeSignal), signal);
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
      assertInteractable(el);
      const changes = observeChanges(500, signal);
      const point=clickPoint(el);
      const base={...point,bubbles:true,cancelable:true,composed:true,button:0,detail:1};
      // A rejected pre-click check must not leave an unhandled observation when
      // the command is cancelled. The observer itself is bounded to 500ms.
      void changes.catch(() => {});
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        const down=type.endsWith('down');
        el.dispatchEvent(new (type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent)(type, {...base,buttons:down?1:0,pointerId:1,pointerType:'mouse',isPrimary:true,pressure:down?0.5:0}));
      }
      try {
        assertInteractable(el);
        // Pointer handlers can recycle a row or change href synchronously.
        resolveRef(String(p.ref));
      } catch (error) {
        throw new ProtocolError('EXECUTION_UNKNOWN',
          'Pointer events were delivered, but the target changed before click. Inspect the page before continuing.',
          'unsafe', { cause: error instanceof ProtocolError ? error.code : 'INTERNAL' });
      }
      // Retain native activation and viewport coordinates after the final check.
      // This is still untrusted input.
      el.dispatchEvent(new MouseEvent('click',{...base,...clickPoint(el),buttons:0}));
      return { executed: true, verified: await changes };
    }
    case "fill": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      const text = String(p.text ?? "");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el instanceof HTMLInputElement && el.type === 'file') throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','File upload is not supported by browser_fill; it cannot read a local path or choose a file.');
        if (el.readOnly) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The field is read-only.");
        el.focus();
        nativeSet(el, text);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const value = el.value;
        const isPassword = el instanceof HTMLInputElement && el.type === "password";
        return { executed: true, verified: isPassword ? { matches: value === text } : { ...verificationValue(value), matches: value === text } };
      }
      if ((el as HTMLElement).isContentEditable) {
        (el as HTMLElement).focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }));
        const value = el.textContent ?? "";
        return { executed: true, verified: { ...verificationValue(value), matches: value === text } };
      }
      throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "browser_fill only works on text inputs, textareas and editable areas.");
    }
    case "select": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      if (el instanceof HTMLSelectElement) {
        const want = String(p.option ?? "");
        const opt = [...el.options].find((o) => o.value === want) ?? [...el.options].find((o) => o.text.trim() === want);
        if (!opt) {
          const labels = [...el.options].slice(0, 20).map(option => option.text.trim());
          throw new ProtocolError("ELEMENT_NOT_FOUND", `No option "${want.slice(0, 128)}${want.length > 128 ? "…" : ""}".`, "never", {
            options: labels.map(label => label.slice(0, 128)), optionsTotal: el.options.length,
            optionsTruncated: el.options.length > labels.length || labels.some(label => label.length > 128),
          });
        }
        if (opt.disabled || (opt.parentElement instanceof HTMLOptGroupElement && opt.parentElement.disabled)) {
          throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The requested option is disabled.");
        }
        nativeSet(el, opt.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const label = el.selectedOptions[0]?.text.trim() ?? "";
        return { executed: true, verified: { ...verificationValue(el.value), label: label.slice(0, 512), ...(label.length > 512 ? { labelTruncated: true } : {}) } };
      }
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const want = p.checked ?? true;
        if (typeof want !== "boolean") throw new ProtocolError("INVALID_PARAMS", "checked must be a boolean.");
        if (el.type === "radio" && el.checked && !want) throw new ProtocolError("INVALID_PARAMS", "A selected radio cannot be cleared by clicking it. Select another radio in the group.");
        const changed = el.checked !== want;
        if (changed) el.click();
        if (el.checked !== want) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The page did not accept the requested checked state.", "never", { executed: changed, checked: el.checked });
        return { executed: changed, verified: { checked: el.checked, matches: true } };
      }
      throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "browser_select works on select, checkbox and radio elements.");
    }
    case "press": return pressKey(p, assertInteractable);
    case "scroll": return scroll(p);
    case "wait": return waitFor(p, signal);
    case "extract": return extract(p);
    default: throw new ProtocolError("INVALID_PARAMS", `Unknown action ${method}`);
  }
}

function scroll(p: P) {
  const el = (p.ref ? resolveRef(String(p.ref)) : document.scrollingElement ?? document.documentElement) as HTMLElement;
  const page = el.clientHeight * 0.8;
  switch (p.direction) {
    case "up": el.scrollBy({ top: -page }); break;
    case "down": el.scrollBy({ top: page }); break;
    case "top": el.scrollTo({ top: 0 }); break;
    case "bottom": el.scrollTo({ top: el.scrollHeight }); break;
    default: throw new ProtocolError("INVALID_PARAMS", "direction must be up, down, top or bottom");
  }
  return Promise.resolve({ executed: true, verified: { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } });
}
