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
    const text = node.textContent ?? '';
    if (text.length > 300) break;
    if (text.trim() && text.trim() !== (el.textContent ?? '').trim()) return node;
  }
  return null;
}

/** Static row identity. Editing a field or updating a live status must not retarget its neighbours.
 * Keep the full identity in memory; only the separately returned display context is truncated. */
export function observeRecord(root: Element): RecordObservation {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(HIDDEN) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let text = '', search = '';
  const omitted = new WeakSet<Element>();
  const links: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      search += node.nodeValue ?? '';
      if (!node.parentElement || !omitted.has(node.parentElement)) text += node.nodeValue ?? '';
    }
    else {
      const el = node as Element;
      if (el.matches(BREAK)) search += ' ';
      if (el.matches(OMIT) || (el.parentElement && omitted.has(el.parentElement))) omitted.add(el);
      else {
        if (el.matches(BREAK)) text += ' ';
        if (el instanceof HTMLAnchorElement) links.push(el.href);
      }
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
