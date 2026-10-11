import { accessibleName, isInteractive, isRendered, roleOf, walkDeep } from "./dom";
import { newTable } from "./refs";

export type SnapElement = { ref: string; role: string; name: string; tag: string; value?: string; checked?: boolean; disabled?: boolean; options?: string[]; href?: string; inShadow?: boolean };
export type TextSlice = { content: string; totalChars: number; offset: number; returnedChars: number; truncated: boolean; nextOffset: number | null };
export type FrameSnapshot = { frameId: number; url: string; title: string; text: TextSlice; elements: SnapElement[]; elementsTruncated: boolean; limits: string[] };

export function sliceText(full: string, offset: number, maxChars: number): TextSlice {
  const content = full.slice(offset, offset + maxChars);
  const end = offset + content.length;
  return { content, totalChars: full.length, offset, returnedChars: content.length, truncated: end < full.length, nextOffset: end < full.length ? end : null };
}

export function pageText(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  return ((body as HTMLElement).innerText ?? body.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function takeSnapshot(o: { snapshotId: number; frameId: number; maxChars: number; offset: number; checkLayout: boolean; maxElements?: number }): FrameSnapshot {
  const max = o.maxElements ?? 150;
  const table = newTable(o.snapshotId, o.frameId);
  const elements: SnapElement[] = [];
  let truncated = false;
  const limits = new Set<string>();
  walkDeep(document, (el, inShadow) => {
    if (el.tagName === "CANVAS") limits.add("canvas-content-not-readable");
    if (!isInteractive(el) || !isRendered(el, { checkLayout: o.checkLayout })) return;
    if (elements.length >= max) { truncated = true; return; }
    const e: SnapElement = { ref: table.add(el), role: roleOf(el), name: accessibleName(el), tag: el.tagName.toLowerCase() };
    if (inShadow) e.inShadow = true;
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") e.checked = el.checked;
      else if (el.type !== "password") e.value = el.value;
    }
    if (el instanceof HTMLTextAreaElement) e.value = el.value;
    if (el instanceof HTMLSelectElement) {
      e.value = el.selectedOptions[0]?.text ?? "";
      e.options = [...el.options].map((op) => op.text);
    }
    if ((el as HTMLButtonElement).disabled) e.disabled = true;
    if (el instanceof HTMLAnchorElement) e.href = el.href;
    elements.push(e);
  });
  return {
    frameId: o.frameId, url: location.href, title: document.title,
    text: sliceText(pageText(document), o.offset, o.maxChars),
    elements, elementsTruncated: truncated, limits: [...limits],
  };
}
