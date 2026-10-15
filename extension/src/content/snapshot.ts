import { accessibleName, isInteractive, isPointerTarget, isRendered, roleOf, walkDeep } from "./dom";
import { newTable } from "./refs";

export type SnapElement = { ref: string; role: string; name: string; tag: string; value?: string; checked?: boolean; disabled?: boolean; options?: string[]; href?: string; inShadow?: boolean; state?: string[]; context?: string };
export type TextSlice = { content: string; totalChars: number; offset: number; returnedChars: number; truncated: boolean; nextOffset: number | null };
export type FrameSnapshot = { frameId: number; url: string; title: string; text: TextSlice; elements: SnapElement[]; elementsTruncated: boolean; elementsTotal: number; elementsOffset: number; elementsNextOffset: number | null; limits: string[] };

export function sliceText(full: string, offset: number, maxChars: number): TextSlice {
  const content = full.slice(offset, offset + maxChars);
  const end = offset + content.length;
  return { content, totalChars: full.length, offset, returnedChars: content.length, truncated: end < full.length, nextOffset: end < full.length ? end : null };
}

export function pageText(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  const plain = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof Element) || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(node.tagName) || !isRendered(node, { checkLayout: false })) return "";
    // Native innerText preserves rendered whitespace. jsdom has no innerText.
    return (node as HTMLElement).innerText ?? [...node.childNodes].map(plain).join("");
  };
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const base = plain(body), parts = [base];
  function shadows(root: Document | ShadowRoot, ancestorText: string) {
    for (const host of root.querySelectorAll("*")) {
      if (!host.shadowRoot || !isRendered(host, { checkLayout: false })) continue;
      const chunks = [...host.shadowRoot.childNodes].map(plain).filter((text) => normalize(text));
      // Some renderers include shadow text in an ancestor's innerText. Compare
      // only against ancestors, so identical independent shadow roots stay distinct.
      for (const chunk of chunks) if (!` ${normalize(ancestorText)} `.includes(` ${normalize(chunk)} `)) parts.push(chunk);
      shadows(host.shadowRoot, `${ancestorText}\n${chunks.join("\n")}`);
    }
  }
  shadows(doc, base);
  return parts.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const MAX_SNAPSHOT_CHARS = 32768;
/** OpenCode drops a one-line tool result above its output limit, so budgets are UTF-8 bytes, not characters. */
export const MAX_SNAPSHOT_BYTES = 24_000;
const encoder = new TextEncoder();
export const utf8Bytes = (value: string) => encoder.encode(value).length;

const RANGE_ROLES = new Set(["slider", "spinbutton", "progressbar", "scrollbar", "meter"]);
export function stateOf(el: Element): string[] {
  const states: string[] = [], aria = (name: string) => el.getAttribute(name);
  if (aria("aria-expanded") === "true") states.push("expanded"); else if (aria("aria-expanded") === "false") states.push("collapsed");
  if (aria("aria-selected") === "true") states.push("selected");
  if (aria("aria-pressed") === "true") states.push("pressed");
  if (aria("aria-checked") === "mixed") states.push("mixed");
  const current = aria("aria-current"); if (current && current !== "false") states.push("current");
  if ((el as HTMLInputElement).required || aria("aria-required") === "true") states.push("required");
  if ((el as HTMLInputElement).readOnly || aria("aria-readonly") === "true") states.push("readonly");
  if (aria("aria-invalid") === "true") states.push("invalid");
  if (el.ownerDocument.activeElement === el) states.push("focused");
  return states;
}

export function takeSnapshot(o: { snapshotId: number; frameId: number; maxChars: number; offset: number; checkLayout: boolean; maxElements?: number; elementOffset?: number }): FrameSnapshot {
  const max = Math.max(1, Math.min(o.maxElements ?? 150, 150));
  const offset = Math.max(0, Math.floor(o.elementOffset ?? 0));
  const table = newTable(o.snapshotId, o.frameId);
  const elements: SnapElement[] = [];
  const limits = new Set<string>();
  const clip = (value: string, size: number) => {
    if (value.length > size) { limits.add("element-fields-truncated"); return value.slice(0, size); }
    return value;
  };
  const fullText = pageText(document);
  const text = sliceText(fullText, o.offset, Math.min(o.maxChars, 20000));
  // JSON escaping can make a character several times larger on the wire.
  while (JSON.stringify(text).length > MAX_SNAPSHOT_CHARS / 2 || utf8Bytes(JSON.stringify(text)) > MAX_SNAPSHOT_BYTES / 2) {
    Object.assign(text, sliceText(fullText, o.offset, Math.max(1, Math.floor(text.returnedChars * .8))));
    limits.add("snapshot-size-limited");
  }
  const result: FrameSnapshot = {
    frameId: o.frameId, url: clip(location.href, 2048), title: clip(document.title, 256), text,
    elements, elementsTruncated: false, elementsTotal: 0, elementsOffset: offset, elementsNextOffset: null, limits: [],
  };
  let budgetFull = false;
  let usedChars = JSON.stringify(result).length, usedBytes = utf8Bytes(JSON.stringify(result));
  walkDeep(document, (el, inShadow) => {
    if (el.tagName === "CANVAS") limits.add("canvas-content-not-readable");
    const pointer = !isInteractive(el) && el.tagName !== "TABLE" && isPointerTarget(el);
    if ((!isInteractive(el) && el.tagName !== "TABLE" && !pointer) || !isRendered(el, { checkLayout: o.checkLayout })) return;
    const index = result.elementsTotal++;
    if (index < offset || elements.length >= max || budgetFull) return;
    const e: SnapElement = { ref: "", role: clip(pointer ? "clickable" : roleOf(el), 80), name: accessibleName(el), tag: clip(el.tagName.toLowerCase(), 80) };
    if (inShadow) e.inShadow = true;
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") e.checked = el.checked;
      else if (el.type !== "password") e.value = clip(el.value, 512);
    }
    if (el instanceof HTMLTextAreaElement) e.value = clip(el.value, 512);
    if (el instanceof HTMLSelectElement) {
      e.value = clip(el.selectedOptions[0]?.text ?? "", 512);
      if (el.options.length > 20) limits.add("element-fields-truncated");
      e.options = [...el.options].slice(0, 20).map(op => clip(op.text, 128));
      while (JSON.stringify(e.options).length > 2048) { e.options.pop(); limits.add("element-fields-truncated"); }
    }
    const ariaChecked = el.getAttribute("aria-checked");
    if (!(el instanceof HTMLInputElement) && (ariaChecked === "true" || ariaChecked === "false")) e.checked = ariaChecked === "true";
    if (!(el instanceof HTMLInputElement) && RANGE_ROLES.has(roleOf(el))) {
      const value = el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow");
      if (value) e.value = clip(value, 80);
    }
    const state = stateOf(el);
    if (state.length) e.state = state;
    if (el.matches(":disabled")) e.disabled = true;
    if (el instanceof HTMLAnchorElement) e.href = clip(el.href, 2048);
    // Reserve space for refs, pagination numbers and limit flags before admitting
    // another item. The cursor stays on that item when the aggregate budget fills.
    // Reserve room for the ref (~16 chars) and the separator before admitting another item.
    const encoded = JSON.stringify(e);
    const itemBytes = utf8Bytes(encoded) + 24;
    if (usedChars + encoded.length + 24 > MAX_SNAPSHOT_CHARS - 1024 || usedBytes + itemBytes > MAX_SNAPSHOT_BYTES - 1024) {
      budgetFull = true; limits.add("snapshot-size-limited"); return;
    }
    usedChars += encoded.length + 24; usedBytes += itemBytes;
    e.ref = table.add(el);
    elements.push(e);
  });
  const next = offset + elements.length;
  result.elementsTruncated = next < result.elementsTotal;
  result.elementsNextOffset = result.elementsTruncated ? next : null;
  result.limits = [...limits];
  return result;
}
