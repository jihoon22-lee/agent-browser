import { ProtocolError } from "../protocol/errors";
import { accessibleName, isRendered } from "./dom";
import { resolveRef } from "./refs";
import { waitFor } from "./wait";
import { extract } from "./extract";
import { observePage } from "./observe";
import { pressKey } from "./keyboard";
import { cancellationError, cancelCommands, withCommandCancellation, type CommandScope } from "./cancellation";

export function cancelUpTo(generation: number) { cancelCommands({ generation }); }

type P = Record<string, unknown> & CommandScope;
const hasLayout = () => document.documentElement.getClientRects().length > 0;

function assertInteractable(el: Element) {
  if (!isRendered(el, { checkLayout: hasLayout() }) || el.matches(":disabled") || el.closest("[inert]")) {
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el) || el.tagName} is hidden or disabled.`);
  }
  if (!hasLayout()) return;
  (el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
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
    case "click": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      const changes = observeChanges(500, signal);
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        el.dispatchEvent(new (type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true }));
      }
      (el as HTMLElement).click();
      return { executed: true, verified: await changes };
    }
    case "fill": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      const text = String(p.text ?? "");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
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
