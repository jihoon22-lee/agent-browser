import { ProtocolError } from "../protocol/errors";
import { accessibleName, isRendered, walkDeep } from "./dom";
import { resolveRef } from "./refs";

const KEYS = new Set(["Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const MODIFIERS = ["Alt", "Control", "Meta", "Shift"];
const CARET = new Set(["Home", "End", "ArrowLeft", "ArrowRight"]);

/** The key and its modifiers, validated before any event: a letter or digit only with a modifier. */
export function keyOf(p: Record<string, unknown>): { key: string; modifiers: string[] } {
  const key = String(p.key), raw = p.modifiers ?? [];
  if (!Array.isArray(raw) || raw.some(m => !MODIFIERS.includes(m)) || new Set(raw).size !== raw.length)
    throw new ProtocolError("INVALID_PARAMS", "modifiers may hold Control, Shift, Alt and Meta, each once.");
  if (!KEYS.has(key) && !(raw.length > 0 && /^[a-zA-Z0-9]$/.test(key)))
    throw new ProtocolError("INVALID_PARAMS", "Unsupported key. Use Enter, Tab, Escape, Space, Backspace, Delete, Home, End, PageUp, PageDown or an arrow; a letter or digit needs modifiers.");
  return { key, modifiers: raw as string[] };
}
const codePointBefore = (value: string, at: number) => Array.from(value.slice(0, at)).at(-1)?.length ?? 1;
const codePointAt = (value: string, at: number) => Array.from(value.slice(at, at + 2))[0]?.length ?? 1;
export const INPUT_TEXT = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);
function activeElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
function editableValue(target: HTMLElement): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && INPUT_TEXT.has(target.type));
}
function replaceSelection(target: HTMLInputElement | HTMLTextAreaElement, text: string, deletion: "backward" | "forward" | null) {
  const start = target.selectionStart, end = target.selectionEnd;
  if (start === null || end === null) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "This input type does not expose an editable text selection. Use browser_fill instead.");
  const from = deletion === "backward" && start === end && start > 0 ? start - codePointBefore(target.value, start) : start;
  const to = deletion === "forward" && start === end && end < target.value.length ? end + codePointAt(target.value, end) : end;
  if (text && target.maxLength >= 0 && target.value.length - (to - from) + text.length > target.maxLength) return false;
  const inputType = deletion === "backward" ? "deleteContentBackward" : deletion === "forward" ? "deleteContentForward" : text === "\n" ? "insertLineBreak" : "insertText";
  if (!target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, composed: true, cancelable: true, inputType, data: deletion ? null : text }))) return false;
  if (target.readOnly || target.matches(":disabled") || !target.isConnected) return false;
  const next = target.value.slice(0, from) + text + target.value.slice(to);
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(target, next);
  target.setSelectionRange(from + text.length, from + text.length);
  target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: deletion ? null : text }));
  return true;
}
/** Home/End go to the line's ends; arrows move one character or collapse a selection; Shift extends from the anchor. */
function moveCaret(target: HTMLInputElement | HTMLTextAreaElement, key: string, extend: boolean) {
  const start = target.selectionStart, end = target.selectionEnd, value = target.value;
  if (start === null || end === null) return false;
  const backward = target.selectionDirection === "backward";
  const anchor = backward ? end : start, focus = backward ? start : end;
  const next = key === "Home" ? value.lastIndexOf("\n", focus - 1) + 1
    : key === "End" ? (value.indexOf("\n", focus) < 0 ? value.length : value.indexOf("\n", focus))
    : !extend && start !== end ? (key === "ArrowLeft" ? start : end)
    : key === "ArrowLeft" ? Math.max(0, focus - (focus > 0 ? codePointBefore(value, focus) : 0)) : Math.min(value.length, focus + (focus < value.length ? codePointAt(value, focus) : 0));
  if (extend) target.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? "backward" : "forward");
  else target.setSelectionRange(next, next);
  return true;
}

/** Checks shared by DOM and trusted key presses: supported key, a focusable target, and no
 * read-only, rich-editor or selection-less editing. Leaves the target focused. */
export function preparePress(p: Record<string, unknown>, validate: (element: Element) => void): HTMLElement {
  const { key, modifiers } = keyOf(p);
  const target = (p.ref ? resolveRef(String(p.ref)) : activeElement() ?? document.body) as HTMLElement;
  validate(target);
  const editableHost = target.closest("[contenteditable]");
  const rich = target.isContentEditable || (editableHost !== null && editableHost.getAttribute("contenteditable") !== "false");
  const edits = modifiers.length === 0 && (key === "Backspace" || key === "Delete" || key === "Space" || (key === "Enter" && (target instanceof HTMLTextAreaElement || rich)) || ((key === "ArrowUp" || key === "ArrowDown") && target instanceof HTMLInputElement && target.type === "number"));
  if (edits && editableValue(target) && target.readOnly) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The field is read-only.");
  if (edits && rich) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "Keyboard editing of rich editable areas is not supported. Use browser_fill.");
  if (edits && editableValue(target) && key !== "ArrowUp" && key !== "ArrowDown" && target.selectionStart === null) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "This field does not support text selection. Use browser_fill.");
  target.focus();
  if (p.ref && activeElement() !== target) throw new ProtocolError("ELEMENT_NOT_INTERACTABLE", "The referenced element cannot receive keyboard focus.");
  return target;
}

/** Moves focus to the next (step 1) or previous (step -1) tabbable element. */
function focusNext(target: HTMLElement, step: 1 | -1) {
  const candidates: HTMLElement[] = [];
  walkDeep(document, el => {
    if (!(el instanceof HTMLElement) || el.tabIndex < 0 || el.matches(":disabled") || el.closest("[inert]") || !isRendered(el, { checkLayout: document.documentElement.getClientRects().length > 0 })) return;
    candidates.push(el);
  });
  // Positive tabindex comes first, then document order (including open roots).
  candidates.sort((a, b) => (a.tabIndex > 0 ? a.tabIndex : Infinity) - (b.tabIndex > 0 ? b.tabIndex : Infinity));
  const at = candidates.indexOf(target);
  const next = candidates[((at < 0 && step < 0 ? 0 : at) + step + candidates.length) % candidates.length];
  next?.focus();
  return !!next && activeElement() === next;
}

export function pressKey(p: Record<string, unknown>, validate: (element: Element) => void): Record<string, unknown> {
  const target = preparePress(p, validate);
  const { key, modifiers } = keyOf(p);
  const has = (m: string) => modifiers.includes(m), shiftOnly = modifiers.length === 1 && has("Shift");
  const single = /^[a-zA-Z0-9]$/.test(key);
  const editableHost = target.closest("[contenteditable]");
  const rich = target.isContentEditable || (editableHost !== null && editableHost.getAttribute("contenteditable") !== "false");
  const edits = modifiers.length === 0 && (key === "Backspace" || key === "Delete" || key === "Space" || (key === "Enter" && (target instanceof HTMLTextAreaElement || rich)) || ((key === "ArrowUp" || key === "ArrowDown") && target instanceof HTMLInputElement && target.type === "number"));
  const event = (type: string) => target.dispatchEvent(new KeyboardEvent(type, {
    key: key === "Space" ? " " : single ? (has("Shift") ? key.toUpperCase() : key.toLowerCase()) : key,
    code: single ? (/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`) : key,
    ctrlKey: has("Control"), shiftKey: has("Shift"), altKey: has("Alt"), metaKey: has("Meta"), bubbles: true, cancelable: true, composed: true }));
  const down = event("keydown"), printable = down && (modifiers.length > 0 || (key !== "Enter" && key !== "Space") || event("keypress"));
  // A Space button action occurs on release. Honor cancellation of either phase.
  const up = key === "Space" ? event("keyup") : true;
  const allowed = down && printable && up;
  let defaultApplied = false, submitted = false, defaultAction = "event-only";
  if (allowed && target.isConnected && !target.matches(":disabled") && !(edits && editableValue(target) && target.readOnly)) {
    const button = target instanceof HTMLButtonElement || (target instanceof HTMLInputElement && ["button", "submit", "reset"].includes(target.type));
    const spaceClick = button || target.tagName === "SUMMARY" || (target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type));
    const enterClick = button || target.tagName === "SUMMARY" || (target instanceof HTMLAnchorElement && target.hasAttribute("href"));
    if (modifiers.length > 0) {
      // Only the few combinations with a well-defined text-field effect are emulated; the rest are events only.
      if (modifiers.length === 1 && (has("Control") || has("Meta")) && key.toLowerCase() === "a" && editableValue(target) && target.selectionStart !== null) {
        target.select(); defaultApplied = true; defaultAction = "select-all";
      } else if (shiftOnly && CARET.has(key) && editableValue(target)) {
        defaultApplied = moveCaret(target, key, true); defaultAction = "move-caret";
      } else if (shiftOnly && key === "Tab") {
        defaultApplied = focusNext(target, -1); defaultAction = "focus-previous";
      }
    } else if ((key === "Enter" && enterClick) || (key === "Space" && spaceClick)) {
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
    } else if (editableValue(target) && (key === "Space" || key === "Backspace" || key === "Delete" || (key === "Enter" && target instanceof HTMLTextAreaElement))) {
      defaultApplied = replaceSelection(target, key === "Space" ? " " : key === "Enter" ? "\n" : "", key === "Backspace" ? "backward" : key === "Delete" ? "forward" : null); defaultAction = "edit";
    } else if (CARET.has(key) && editableValue(target)) {
      defaultApplied = moveCaret(target, key, false); defaultAction = "move-caret";
    } else if (key === "Tab") {
      defaultApplied = focusNext(target, 1); defaultAction = "focus-next";
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
  const verified: Record<string, unknown> = { key, ...(modifiers.length ? { modifiers } : {}), synthetic: true, defaultApplied, defaultAction, defaultPrevented: !allowed, submitted, activeElement: activeElement() ? accessibleName(activeElement()!) : null };
  if (target instanceof HTMLInputElement) {
    if (["checkbox", "radio"].includes(target.type)) verified.checked = target.checked;
    else if (target.type !== "password") verified.value = target.value.slice(0, 512);
  } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) verified.value = target.value.slice(0, 512);
  if ((target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type !== "password")) && target.value.length > 512) verified.valueTruncated = true;
  return { executed: true, verified };
}
