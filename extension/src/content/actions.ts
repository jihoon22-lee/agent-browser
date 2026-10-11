import { ProtocolError } from "../protocol/errors";
import { accessibleName, isRendered } from "./dom";
import { resolveRef } from "./refs";
import { waitFor } from "./wait";
import { extract } from "./extract";

let cancelledGeneration = 0;
export function cancelUpTo(generation: number) { cancelledGeneration = Math.max(cancelledGeneration, generation); }

type P = Record<string, unknown> & { generation: number };
const hasLayout = () => document.documentElement.getClientRects().length > 0;

function assertInteractable(el: Element) {
  if (!isRendered(el, { checkLayout: hasLayout() }) || (el as HTMLButtonElement).disabled || el.closest("[inert]")) {
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el) || el.tagName} is hidden or disabled.`);
  }
  if (!hasLayout()) return;
  (el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (top && top !== el && !el.contains(top) && !(top.shadowRoot && top.contains(el))) {
    throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", `${accessibleName(el)} is covered by another element.`, "never",
      { coveredBy: { tag: top.tagName.toLowerCase(), name: accessibleName(top) } });
  }
}

function observeChanges(ms: number): Promise<{ urlChanged: boolean; domChanged: boolean }> {
  const startUrl = location.href;
  let mutated = false;
  const mo = new MutationObserver(() => { mutated = true; });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  return new Promise((resolve) => setTimeout(() => { mo.disconnect(); resolve({ urlChanged: location.href !== startUrl, domChanged: mutated }); }, ms));
}

function nativeSet(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

export async function runAction(method: string, p: P): Promise<Record<string, unknown>> {
  if (p.generation <= cancelledGeneration) throw new ProtocolError("CANCELLED", "This operation was stopped by the user.");
  switch (method) {
    case "click": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      const changes = observeChanges(500);
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
        return { executed: true, verified: isPassword ? { matches: value === text } : { value, matches: value === text } };
      }
      if ((el as HTMLElement).isContentEditable) {
        (el as HTMLElement).focus();
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: text }));
        return { executed: true, verified: { value: el.textContent, matches: el.textContent === text } };
      }
      throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "browser_fill only works on text inputs, textareas and editable areas.");
    }
    case "select": {
      const el = resolveRef(String(p.ref));
      assertInteractable(el);
      if (el instanceof HTMLSelectElement) {
        const want = String(p.option ?? "");
        const opt = [...el.options].find((o) => o.value === want) ?? [...el.options].find((o) => o.text.trim() === want);
        if (!opt) throw new ProtocolError("ELEMENT_NOT_FOUND", `No option "${want}".`, "never", { options: [...el.options].map((o) => o.text.trim()) });
        nativeSet(el, opt.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { executed: true, verified: { value: el.value, label: opt.text.trim() } };
      }
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const want = p.checked ?? true;
        if (el.checked !== want) el.click();
        return { executed: el.checked === want, verified: { checked: el.checked } };
      }
      throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "browser_select works on select, checkbox and radio elements.");
    }
    case "press": return press(p);
    case "scroll": return scroll(p);
    case "wait": return waitFor(p);
    case "extract": return extract(p);
    default: throw new ProtocolError("INVALID_PARAMS", `Unknown action ${method}`);
  }
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);

function press(p: P) {
  const target = (p.ref ? resolveRef(String(p.ref)) : document.activeElement ?? document.body) as HTMLElement;
  const key = String(p.key);
  const code = key === "Space" ? " " : key;
  const init = { key: code, bubbles: true, cancelable: true, composed: true };
  const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (key === "Enter" || key === "Space") target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
  let submitted = false;
  if (key === "Enter" && down && target instanceof HTMLInputElement && target.form && TEXT_INPUT_TYPES.has(target.type)) {
    target.form.requestSubmit();
    submitted = true;
  }
  if (key === "Tab" && down) {
    const focusables = [...document.querySelectorAll<HTMLElement>("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])")].filter((e) => !(e as HTMLButtonElement).disabled);
    focusables[(focusables.indexOf(target) + 1) % focusables.length]?.focus();
  }
  return Promise.resolve({ executed: true, verified: { submitted, activeElement: document.activeElement ? accessibleName(document.activeElement) : null } });
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
