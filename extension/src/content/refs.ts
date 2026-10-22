import { accessibleName, roleOf } from "./dom";
import { ProtocolError } from "../protocol/errors";
import { recordRoot, observeRecord, recordObservation, type RecordObservation } from './record-context';

const REF_RE = /^s([0-9a-z]+)f(\d+)e(\d+)$/;
export const snapshotToken = (id: number) => id.toString(36);
const KEEP = 5;

export class RefTable {
  private els: { node: WeakRef<Element>; identity: string; record: WeakRef<Element> | null; recordIdentity: string }[] = [];
  // Identity, not array position, protects recycled list rows. Editable values are
  // deliberately excluded so fill/select do not invalidate their own controls.
  private identity(el: Element): string {
    return JSON.stringify([roleOf(el), accessibleName(el, true, Infinity),
      // Native fill changes value, not authored default text. A changed default
      // signals that a reused textarea now belongs to another record.
      el instanceof HTMLTextAreaElement ? el.defaultValue : null,
      el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href'),
      el.getAttribute('target'), el.getAttribute('type'), el.getAttribute('formaction')]);
  }
  constructor(public snapshotId: number, public frameId: number) {}
  add(el: Element, records = new Map<Element,RecordObservation>()): string {
    const root = recordRoot(el);
    const identity = root ? recordObservation(root,records).identity : '';
    this.els.push({ node: new WeakRef(el), identity: this.identity(el), record: root ? new WeakRef(root) : null, recordIdentity: identity ?? '' });
    return `s${snapshotToken(this.snapshotId)}f${this.frameId}e${this.els.length}`;
  }
  get(index: number, allowChanged = false): Element | undefined {
    const entry = this.els[index - 1], el = entry?.node.deref();
    if (!el || allowChanged) return el;
    const root = recordRoot(el), original = entry!.record?.deref() ?? null;
    return root === original && entry!.identity === this.identity(el) && (!root || entry!.recordIdentity === observeRecord(root).identity) ? el : undefined;
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
export function resolveRef(ref: string, allowDetached = false): Element {
  const p = RefTable.parse(ref);
  if (!p) throw new ProtocolError("ELEMENT_NOT_FOUND", `"${ref}" is not an element ref. Use a ref like s3f0e12 from browser_snapshot.`);
  const t = tables.find((x) => x.snapshotId === p.snapshotId && x.frameId === p.frameId);
  const el = t?.get(p.index, allowDetached);
  if (!t || !el || (!allowDetached && !el.isConnected)) {
    throw new ProtocolError("STALE_ELEMENT", `Element ref ${ref} is no longer in the page. Take a new browser_snapshot.`, "never", { ref });
  }
  return el;
}
