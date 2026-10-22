const INTERACTIVE = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider],[role=treeitem],[contenteditable=''],[contenteditable=true],[contenteditable=plaintext-only]";
export const isInteractive = (el: Element) => el.matches(INTERACTIVE+', [onclick], [onmousedown], [onpointerdown], [draggable=true]') ||
  // A label that opens a hidden file input is the page's upload button.
  (el instanceof HTMLLabelElement && el.control instanceof HTMLInputElement && el.control.type === 'file') ||
  (el.hasAttribute('tabindex') && (el as HTMLElement).tabIndex>=0);

export function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  // A detached anchor/area is its own root and has a URL `host` string.
  return root instanceof ShadowRoot ? root.host : null;
}
export function isDisabled(el: Element): boolean {
  if (el.matches(':disabled')) return true;
  for (let node: Element | null = el; node; node = composedParent(node))
    if (node.hasAttribute('inert') || node.getAttribute('aria-disabled') === 'true') return true;
  return false;
}

/** Frameworks attach click handlers at the root, so a pointer cursor is often the only DOM
 * signal. Count only the outermost pointer region outside an existing control. */
export function isPointerTarget(el: Element): boolean {
  const doc = el.ownerDocument;
  if (!(el instanceof HTMLElement) || el === doc.body || el === doc.documentElement) return false;
  if (getComputedStyle(el).cursor !== "pointer") return false;
  const parent = el.parentElement;
  if (parent && getComputedStyle(parent).cursor === "pointer") return false;
  // A card that holds its own button or link is acted on through that control.
  // Hidden or disabled controls cannot stand in for the card, so it stays listed then.
  if ([...el.querySelectorAll(INTERACTIVE)].some(control => !control.matches(":disabled") && isRendered(control, { checkLayout: false }))) return false;
  return !parent?.closest(INTERACTIVE);
}

export function isRendered(el: Element, opts: { checkLayout: boolean }): boolean {
  for (let n: Element | null = el; n; n = composedParent(n)) {
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

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

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

export type NameCache = WeakMap<Node,Map<Element,string>>;
export function accessibleName(el: Element, excludeEditableValue = false, maxLength = 80, labels?: NameCache): string {
  return nameOf(el, excludeEditableValue, new Set(), labels).slice(0, maxLength);
}
function nameOf(el: Element, excludeEditableValue: boolean, visiting: Set<Element>, cache?: NameCache): string {
  const by = el.getAttribute('aria-labelledby');
  if (by && !visiting.has(el)) {
    const path = new Set(visiting); path.add(el);
    // IDs in a shadow tree are local to that tree. Do not bind a same-named document element.
    const root = el.getRootNode() as Document | ShadowRoot;
    const text = clean(by.split(/\s+/).map(id => {
      const target = root.getElementById?.(id);
      return target ? nameOf(target, excludeEditableValue, path, cache) : '';
    }).join(' '));
    if (text) return text;
  }
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  if ("labels" in el) {
    if(cache) {
      // Chrome's native labels getter can scan the tree for each control. Build
      // associations once for this synchronous snapshot, separately in each root.
      const root=el.getRootNode() as Document|ShadowRoot;
      let names=cache.get(root);
      if(!names){
        names=new Map();cache.set(root,names);
        for(const label of root.querySelectorAll('label')){
          const control=label.control;
          if(control)names.set(control,clean((names.get(control)??'')+' '+label.textContent));
        }
      }
      const name=names.get(el);if(name)return name;
    }else{
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length) {
        const t = clean([...labels].map((l) => l.textContent).join(" "));
        if (t) return t;
      }
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
