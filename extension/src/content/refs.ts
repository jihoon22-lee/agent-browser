import { ProtocolError } from "../protocol/errors";

const REF_RE = /^s(\d+)f(\d+)e(\d+)$/;
const KEEP = 5;

export class RefTable {
  private els: WeakRef<Element>[] = [];
  constructor(public snapshotId: number, public frameId: number) {}
  add(el: Element): string { this.els.push(new WeakRef(el)); return `s${this.snapshotId}f${this.frameId}e${this.els.length}`; }
  get(index: number): Element | undefined { return this.els[index - 1]?.deref(); }
  static parse(ref: string) {
    const m = REF_RE.exec(ref);
    return m ? { snapshotId: Number(m[1]), frameId: Number(m[2]), index: Number(m[3]) } : null;
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
export function resolveRef(ref: string): Element {
  const p = RefTable.parse(ref);
  if (!p) throw new ProtocolError("ELEMENT_NOT_FOUND", `"${ref}" is not an element ref. Use a ref like s3f0e12 from browser_snapshot.`);
  const t = tables.find((x) => x.snapshotId === p.snapshotId && x.frameId === p.frameId);
  const el = t?.get(p.index);
  if (!t || !el || !el.isConnected) {
    throw new ProtocolError("STALE_ELEMENT", `Element ref ${ref} is no longer in the page. Take a new browser_snapshot.`, "never", { ref });
  }
  return el;
}
