import { ProtocolError } from "../protocol/errors";
import { accessibleName, isRendered, walkDeep } from "./dom";
import { resolveRef } from "./refs";

const KEYS = new Set(["Enter", "Tab", "Escape", "Space", "Backspace", "ArrowUp", "ArrowDown"]);
export const INPUT_TEXT = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);
function activeElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
function editableValue(target: HTMLElement): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && INPUT_TEXT.has(target.type));
}
function replaceSelection(target: HTMLInputElement | HTMLTextAreaElement, text: string, backward: boolean) {
  const start = target.selectionStart, end = target.selectionEnd;
  if (start === null || end === null) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "This input type does not expose an editable text selection. Use browser_fill instead.");
  const from = backward && start === end && start > 0 ? start - (Array.from(target.value.slice(0, start)).at(-1)?.length ?? 1) : start;
  if (text && target.maxLength >= 0 && target.value.length - (end - from) + text.length > target.maxLength) return false;
  const inputType = backward ? "deleteContentBackward" : text === "\n" ? "insertLineBreak" : "insertText";
  if (!target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType, data: backward ? null : text }))) return false;
  if (target.readOnly || target.matches(":disabled") || !target.isConnected) return false;
  const next = target.value.slice(0, from) + text + target.value.slice(end);
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(target, next);
  target.setSelectionRange(from + text.length, from + text.length);
  target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: backward ? null : text }));
  return true;
}

/** Checks shared by DOM and trusted key presses: supported key, a focusable target, and no
 * read-only, rich-editor or selection-less editing. Leaves the target focused. */
export function preparePress(p: Record<string, unknown>, validate: (element: Element) => void): HTMLElement {
  const key = String(p.key);
  if (!KEYS.has(key)) throw new ProtocolError("INVALID_PARAMS", "Unsupported key. Use Enter, Tab, Escape, Space, Backspace, ArrowUp or ArrowDown.");
  const target = (p.ref ? resolveRef(String(p.ref)) : activeElement() ?? document.body) as HTMLElement;
  validate(target);
  const editableHost = target.closest("[contenteditable]");
  const rich = target.isContentEditable || (editableHost !== null && editableHost.getAttribute("contenteditable") !== "false");
  const edits = key === "Backspace" || key === "Space" || (key === "Enter" && (target instanceof HTMLTextAreaElement || rich)) || ((key === "ArrowUp" || key === "ArrowDown") && target instanceof HTMLInputElement && target.type === "number");
  if (edits && editableValue(target) && target.readOnly) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The field is read-only.");
  if (edits && rich) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "Keyboard editing of rich editable areas is not supported. Use browser_fill.");
  if (edits && editableValue(target) && key !== "ArrowUp" && key !== "ArrowDown" && target.selectionStart === null) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "This field does not support text selection. Use browser_fill.");
  target.focus();
  if (p.ref && activeElement() !== target) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The referenced element cannot receive keyboard focus.");
  return target;
}

export function pressKey(p: Record<string, unknown>, validate: (element: Element) => void): Record<string, unknown> {
  const key = String(p.key);
  const target = preparePress(p, validate);
  const editableHost = target.closest("[contenteditable]");
  const rich = target.isContentEditable || (editableHost !== null && editableHost.getAttribute("contenteditable") !== "false");
  const edits = key === "Backspace" || key === "Space" || (key === "Enter" && (target instanceof HTMLTextAreaElement || rich)) || ((key === "ArrowUp" || key === "ArrowDown") && target instanceof HTMLInputElement && target.type === "number");
  const event = (type: string) => target.dispatchEvent(new KeyboardEvent(type, { key: key === "Space" ? " " : key, code: key, bubbles: true, cancelable: true, composed: true }));
  const down = event("keydown"), printable = down && ((key !== "Enter" && key !== "Space") || event("keypress"));
  // A Space button action occurs on release. Honor cancellation of either phase.
  const up = key === "Space" ? event("keyup") : true;
  const allowed = down && printable && up;
  let defaultApplied = false, submitted = false, defaultAction = "event-only";
  if (allowed && target.isConnected && !target.matches(":disabled") && !(edits && editableValue(target) && target.readOnly)) {
    const button = target instanceof HTMLButtonElement || (target instanceof HTMLInputElement && ["button", "submit", "reset"].includes(target.type));
    const spaceClick = button || target.tagName === "SUMMARY" || (target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type));
    const enterClick = button || target.tagName === "SUMMARY" || (target instanceof HTMLAnchorElement && target.hasAttribute("href"));
    if ((key === "Enter" && enterClick) || (key === "Space" && spaceClick)) {
      target.click(); defaultApplied = true; defaultAction = "click";
    } else if (key === "Enter" && target instanceof HTMLInputElement && INPUT_TEXT.has(target.type) && target.form) {
      // Native implicit submit uses the default submitter (including its name/value).
      const form = target.form;
      // form.elements omits image inputs. Include external form-associated controls in tree order.
      const submitter = [...(form.getRootNode() as Document | ShadowRoot).querySelectorAll("button,input")].find(el =>
        (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.form === form &&
        (el.type === "submit" || el instanceof HTMLInputElement && el.type === "image")) as HTMLElement | undefined;
      const blockers = [...form.elements].filter(el => el instanceof HTMLInputElement && INPUT_TEXT.has(el.type));
      if (submitter ? !submitter.matches(":disabled") : blockers.length <= 1) {
        const form = target.form, onSubmit = () => { submitted = true; };
        form.addEventListener("submit", onSubmit, { capture: true });
        try {
          if (submitter) { submitter.click(); defaultApplied = true; }
          else { form.requestSubmit(); defaultApplied = submitted; }
        }
        finally { form.removeEventListener("submit", onSubmit, { capture: true }); }
      }
      defaultAction = "submit";
    } else if (editableValue(target) && (key === "Space" || key === "Backspace" || (key === "Enter" && target instanceof HTMLTextAreaElement))) {
      defaultApplied = replaceSelection(target, key === "Space" ? " " : key === "Enter" ? "\n" : "", key === "Backspace"); defaultAction = "edit";
    } else if (key === "Tab") {
      const candidates: HTMLElement[] = [];
      walkDeep(document, el => {
        if (!(el instanceof HTMLElement) || el.tabIndex < 0 || el.matches(":disabled") || el.closest("[inert]") || !isRendered(el, { checkLayout: document.documentElement.getClientRects().length > 0 })) return;
        candidates.push(el);
      });
      // Positive tabindex comes first, then document order (including open roots).
      candidates.sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
      const next = candidates[(candidates.indexOf(target) + 1) % candidates.length];
      next?.focus(); defaultApplied = !!next && activeElement() === next; defaultAction = "focus-next";
    } else if ((key === "ArrowUp" || key === "ArrowDown") && target instanceof HTMLSelectElement) {
      const step = key === "ArrowUp" ? -1 : 1;
      for (let index = target.selectedIndex + step; index >= 0 && index < target.options.length; index += step) {
        const option = target.options[index]!;
        if (option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) continue;
        target.selectedIndex = index; target.dispatchEvent(new Event("input", { bubbles: true })); target.dispatchEvent(new Event("change", { bubbles: true })); defaultApplied = true; break;
      }
      defaultAction = "select-option";
    } else if ((key === "ArrowUp" || key === "ArrowDown") && target instanceof HTMLInputElement && target.type === "number") {
      const before = target.value;
      try { key === "ArrowUp" ? target.stepUp() : target.stepDown(); }
      catch { throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "This number field does not support stepping.", "never", { executed: true }); }
      defaultApplied = before !== target.value; defaultAction = "step-number";
      if (defaultApplied) { target.dispatchEvent(new Event("input", { bubbles: true })); target.dispatchEvent(new Event("change", { bubbles: true })); }
    } else if (key === "Escape") {
      const dialog = target.closest("dialog[open]") as HTMLDialogElement | null;
      if (dialog && dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) { dialog.close(); defaultApplied = true; defaultAction = "close-dialog"; }
    }
  }
  if (key !== "Space") event("keyup");
  const verified: Record<string, unknown> = { key, synthetic: true, defaultApplied, defaultAction, defaultPrevented: !allowed, submitted, activeElement: activeElement() ? accessibleName(activeElement()!) : null };
  if (target instanceof HTMLInputElement) {
    if (["checkbox", "radio"].includes(target.type)) verified.checked = target.checked;
    else if (target.type !== "password") verified.value = target.value.slice(0, 512);
  } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) verified.value = target.value.slice(0, 512);
  if ((target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type !== "password")) && target.value.length > 512) verified.valueTruncated = true;
  return { executed: true, verified };
}
