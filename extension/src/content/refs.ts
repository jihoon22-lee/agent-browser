import { accessibleName, composedParent, roleOf, type NameCache } from "./dom";
import { ProtocolError } from "../protocol/errors";
import { recordRoot, observeRecord, recordObservation, type RecordObservation } from './record-context';

const REF_RE = /^s([0-9a-z]+)f(\d+)e(\d+)$/;
export const snapshotToken = (id: number) => id.toString(36);
const KEEP = 5;
const recordKey = (root: Element | null) => JSON.stringify([root?.getAttribute('data-id'),root?.getAttribute('data-key')]);

export class RefTable {
  private els: { node: WeakRef<Element>; parent: WeakRef<Node> | null; identity: string; record: WeakRef<Element> | null; recordIdentity: string; recordKey: string }[] = [];
  // Identity, not array position, protects recycled list rows. Editable values are
  // deliberately excluded so fill/select do not invalidate their own controls.
  private identity(el: Element, names?: NameCache): string {
    return JSON.stringify([roleOf(el), accessibleName(el, true, Infinity, names),
      // Native fill changes value, not authored default text. A changed default
      // signals that a reused textarea now belongs to another record.
      el instanceof HTMLTextAreaElement ? el.defaultValue : null,
      el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href'),
      el.getAttribute('target'), el.getAttribute('type'), el.getAttribute('formaction')]);
  }
  constructor(public snapshotId: number, public frameId: number) {}
  add(el: Element, records = new Map<Element,RecordObservation>(), names?: NameCache): string {
    const root = recordRoot(el);
    const identity = root ? recordObservation(root,records).identity : '';
    this.els.push({ node: new WeakRef(el), parent: el.parentNode ? new WeakRef(el.parentNode) : null, identity: this.identity(el,names), record: root ? new WeakRef(root) : null, recordIdentity: identity ?? '', recordKey: recordKey(root) });
    return `s${snapshotToken(this.snapshotId)}f${this.frameId}e${this.els.length}`;
  }
  get(index: number, allowChanged = false, scope: 'record' | 'target' = 'record'): Element | undefined {
    const entry = this.els[index - 1], el = entry?.node.deref();
    if (!el || allowChanged) return el;
    const original = entry!.record?.deref() ?? null;
    if(entry!.record && !original)return undefined;
    if(entry!.identity !== this.identity(el))return undefined;
    if(scope === 'target') {
      // Text changes may create/remove the heuristic small-card classification.
      // Verify structural membership in the original record, not that heuristic again.
      let ancestor:Element|null=el;
      while(ancestor && ancestor!==original)ancestor=composedParent(ancestor);
      return el.parentNode===(entry!.parent?.deref()??null) && ancestor===original
        && entry!.recordKey===recordKey(original) ? el : undefined;
    }
    const root = recordRoot(el);
    return root === original && (!root || entry!.recordIdentity === observeRecord(root).identity) ? el : undefined;
  }
  static parse(ref: string) {
    const m = REF_RE.exec(ref);
    return m ? { snapshotId: parseInt(m[1]!, 36), frameId: Number(m[2]), index: Number(m[3]) } : null;
  }
}

let tables: RefTable[] = [];
export function resetRegistry() { tables = []; }
export function newTable(snapshotId: number, frameId: number): RefTable {
  const t = new RefTable(snapshotId, frameId);
  tables.push(t);
  if (tables.length > KEEP) tables.shift();
  return t;
}
export function resolveRef(ref: string, allowDetached = false, scope: 'record' | 'target' = 'record'): Element {
  const p = RefTable.parse(ref);
  if (!p) throw new ProtocolError("ELEMENT_NOT_FOUND", `"${ref}" is not an element ref. Use a ref like s3f0e12 from browser_snapshot.`);
  const t = tables.find((x) => x.snapshotId === p.snapshotId && x.frameId === p.frameId);
  const el = t?.get(p.index, allowDetached, scope);
  if (!t || !el || (!allowDetached && !el.isConnected)) {
    throw new ProtocolError("STALE_ELEMENT", `Element ref ${ref} is no longer in the page. Take a new browser_snapshot.`, "never", { ref });
  }
  return el;
}
