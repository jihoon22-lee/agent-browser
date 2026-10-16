const INTERACTIVE = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider],[role=treeitem],[contenteditable=''],[contenteditable=true],[contenteditable=plaintext-only]";
export const isInteractive = (el: Element) => el.matches(INTERACTIVE+', [onclick], [onmousedown], [onpointerdown]') ||
  (el.hasAttribute('tabindex') && (el as HTMLElement).tabIndex>=0);

/** Frameworks attach click handlers at the root, so a pointer cursor is often the only DOM
 * signal. Count only the outermost pointer region outside an existing control. */
export function isPointerTarget(el: Element): boolean {
  const doc = el.ownerDocument;
  if (!(el instanceof HTMLElement) || el === doc.body || el === doc.documentElement) return false;
  if (getComputedStyle(el).cursor !== "pointer") return false;
  const parent = el.parentElement;
  if (parent && getComputedStyle(parent).cursor === "pointer") return false;
  // A card that holds its own button or link is acted on through that control.
  if (el.querySelector(INTERACTIVE)) return false;
  return !parent?.closest(INTERACTIVE);
}

export function isRendered(el: Element, opts: { checkLayout: boolean }): boolean {
  for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
    if ((n as HTMLElement).hidden) return false;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
  }
  return opts.checkLayout ? el.getClientRects().length > 0 : true;
}

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset") return "button";
    return "textbox";
  }
  return (el as HTMLElement).isContentEditable ? "textbox" : tag;
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

/** Icon controls often carry their only name on a nested image, SVG title or labelled icon. */
function nestedLabel(el: Element): string {
  for (const node of el.querySelectorAll("img[alt], svg title, [aria-label]")) {
    const value = node instanceof HTMLImageElement ? node.alt
      : node.tagName.toLowerCase() === "title" ? node.textContent : node.getAttribute("aria-label");
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

export function accessibleName(el: Element, excludeEditableValue = false): string {
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = clean(by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent).join(" "));
    if (t) return t;
  }
  if ("labels" in el) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = clean([...labels].map((l) => l.textContent).join(" "));
      if (t) return t;
    }
  }
  const ph = clean(el.getAttribute("placeholder"));
  if (ph) return ph;
  const editable = el instanceof HTMLInputElement || (el as HTMLElement).isContentEditable;
  const text = excludeEditableValue && editable ? '' : clean((el as HTMLElement).innerText ?? el.textContent);
  if (text) return text;
  const nested = nestedLabel(el);
  if (nested) return nested;
  const title = clean(el.getAttribute("title"));
  if (title) return title;
  // An input's value is what the user typed, not its name (and may be a password). Only
  // submit/button/reset inputs use their value as the visible label.
  if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) return clean(el.value);
  return "";
}

export function walkDeep(root: Document | ShadowRoot, visit: (el: Element, inShadow: boolean) => void, inShadow = false) {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n as Element;
    visit(el, inShadow);
    if (el.shadowRoot) walkDeep(el.shadowRoot, visit, true);
  }
}
