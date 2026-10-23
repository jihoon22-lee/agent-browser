import { composedParent } from './dom';

const RECORD = 'tr,li,article,[role=row],[role=listitem],[data-id],[data-key]';
const OMIT = 'script,style,template,noscript,input,textarea,select,button,[contenteditable],'
  + '[role=button],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=switch],'
  + '[role=status],[role=alert],[role=progressbar],[role=timer],[hidden],[aria-hidden=true]';
const BREAK = 'td,th,div,p,br,section,header,footer,h1,h2,h3,h4,h5,h6,[role=cell],[role=gridcell]';
const HIDDEN = 'script,style,template,noscript,[hidden]';
export type RecordObservation = { identity: string; text: string; search: string };

export function recordRoot(el: Element): Element | null {
  for (let node = composedParent(el); node && node !== el.ownerDocument.body; node = composedParent(node))
    if (node.matches(RECORD)) return node;
  // Many cards have no ARIA/list markup. Bind a small nearby container with text
  // beyond this control, never an entire page/form or an arbitrary distant ancestor.
  let depth = 0;
  for (let node = composedParent(el); node && node !== el.ownerDocument.body && depth++ < 3; node = composedParent(node)) {
    if (!node.matches('div,section')) break;
    const text = node.shadowRoot ? observeRecord(node).text : node.textContent ?? '';
    if (text.length > 300) break;
    if (text.trim() && text.trim() !== (el.textContent ?? '').trim()) return node;
  }
  return null;
}

/** Static row identity. Editing a field or updating a live status must not retarget its neighbours.
 * Keep the full identity in memory; only the separately returned display context is truncated. */
export function observeRecord(root: Element): RecordObservation {
  // Traverse the rendered composition: a host's open root replaces its light
  // children, and a slot contributes assigned nodes (or its fallback) once.
  const children = (el: Element): Node[] => {
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return [...(el.shadowRoot ?? el).childNodes];
  };
  const stack = children(root).reverse().map(node => ({ node, omitted: false }));
  const visited = new WeakSet<Node>();
  let text = '', search = '';
  const links: string[] = [];
  while (stack.length) {
    const { node, omitted } = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? '';
      search += value;
      if (!omitted) text += value;
    }
    else if (node instanceof Element) {
      const el = node;
      if (el.matches(HIDDEN)) continue;
      if (el.matches(BREAK)) search += ' ';
      const skipIdentity = omitted || el.matches(OMIT);
      if (!skipIdentity) {
        if (el.matches(BREAK)) text += ' ';
        if (el instanceof HTMLAnchorElement) links.push(el.href);
      }
      for (const child of children(el).reverse()) stack.push({ node: child, omitted: skipIdentity });
    }
  }
  text = text.replace(/\s+/g,' ').trim();
  return { text, search:search.replace(/\s+/g,' ').trim().slice(0,300), identity:JSON.stringify([text,root.getAttribute('data-id'),root.getAttribute('data-key'),links]) };
}
export function recordObservation(root: Element, cache: Map<Element,RecordObservation>): RecordObservation {
  let data = cache.get(root);
  if (!data) { data = observeRecord(root); cache.set(root,data); }
  return data;
}
export function recordText(el: Element, cache: Map<Element,RecordObservation>): string {
  const root = recordRoot(el);
  if (!root) return '';
  return recordObservation(root,cache).text;
}
