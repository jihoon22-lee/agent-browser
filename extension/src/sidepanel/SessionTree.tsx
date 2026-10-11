import { useEffect, useRef, useState } from "react";
import type { Data } from "./workbench-state";
import { RenameField, SessionMenu, type SessionAction } from "./SessionActions";

export function relativeTime(value: number | undefined, now = Date.now()): string {
  if (!value) return "";
  const minutes = Math.floor((now - value) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return new Date(value).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

type Props = {
  sessions: Data[]; selectedId: string; statuses: Record<string, Data>; directory: string;
  childIndex: Record<string, Data[]>; ensureChildren: (ids: string[]) => void; loadChildren: (id: string) => Promise<Data[]>;
  onSelect: (session: Data) => void; actions: (session: Data) => SessionAction[];
  renamingId?: string; onRename: (session: Data, title: string) => void; onRenameEnd: () => void;
};
export function SessionTree({ sessions, selectedId, statuses, directory, childIndex, ensureChildren, loadChildren, onSelect, actions, renamingId, onRename, onRenameEnd }: Props) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(new Set<string>()), [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true), pending = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Only rows on screen are checked for children: the roots plus the children of expanded rows.
  const visible: string[] = [];
  const collect = (list: Data[], ancestry: Set<string>) => { for (const session of list) if (!ancestry.has(session.id)) { visible.push(session.id); if (expanded.has(session.id)) collect(childIndex[session.id] ?? [], new Set(ancestry).add(session.id)); } };
  collect(sessions, new Set());
  const visibleKey = visible.join(",");
  useEffect(() => { if (visibleKey) ensureChildren(visibleKey.split(",")); }, [visibleKey, ensureChildren]);
  async function toggle(id: string) {
    if (expanded.has(id)) { setExpanded(previous => { const next = new Set(previous); next.delete(id); return next; }); return; }
    setExpanded(previous => new Set(previous).add(id));
    if (pending.current.has(id)) return;
    pending.current.add(id); setLoading(previous => new Set(previous).add(id));
    setErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
    try { await loadChildren(id); }
    catch (error) { if (mounted.current) setErrors(previous => ({ ...previous, [id]: error instanceof Error ? error.message : String(error) })); }
    finally { pending.current.delete(id); if (mounted.current) setLoading(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  }
  const render = (session: Data, ancestry: Set<string>): React.ReactNode => {
    if (ancestry.has(session.id)) return null;
    const path = new Set(ancestry).add(session.id), open = expanded.has(session.id), childId = `session-children-${session.id}`;
    const children = childIndex[session.id], busy = ["busy", "retry"].includes(statuses[session.id]?.type);
    const otherDirectory = session.directory && session.directory !== directory ? session.directory : "";
    return <li key={session.id}><div className={`session-row ${session.id === selectedId ? "selected" : ""}`}>
      {children?.length ? <button className="tree-toggle" aria-label={`${session.title} 하위 세션 ${open ? "접기" : "펼치기"}`} aria-expanded={open} aria-controls={childId} onClick={() => void toggle(session.id)}>{open ? "⌄" : "›"}</button> : <span className="tree-spacer" aria-hidden="true" />}
      {renamingId === session.id
        ? <div className="session-open renaming"><RenameField initial={session.title} onSubmit={title => { onRenameEnd(); onRename(session, title); }} onCancel={onRenameEnd} /></div>
        : <button className={`session-open ${session.id === selectedId ? "selected" : ""}`} aria-current={session.id === selectedId ? "true" : undefined} title={busy ? "실행 중인 작업에 연결" : session.parentID ? "하위 세션 열기" : "저장된 대화 열기"} onClick={() => onSelect(session)}>
          <strong>{session.title}</strong>
          <small>{busy && <span className="running-dot">실행 중 · </span>}{relativeTime(session.time?.updated)}{children?.length ? ` · 하위 ${children.length}` : ""}</small>
          {otherDirectory && <small className="session-directory">{otherDirectory}</small>}
        </button>}
      <SessionMenu label={`${session.title} 세션 작업`} actions={actions(session)} />
    </div>{open && <div id={childId} className="session-children">
      {loading.has(session.id) && !children?.length && <p className="muted" role="status">하위 세션을 불러오는 중…</p>}
      {errors[session.id] && <p role="alert" className="error">{errors[session.id]} 다시 펼쳐 재시도하세요.</p>}
      {children?.length === 0 && !loading.has(session.id) && <p className="muted">하위 세션이 없습니다.</p>}
      {!!children?.length && <ul>{children.map(child => render(child, path))}</ul>}
    </div>}</li>;
  };
  return <ul className="session-list session-tree">{sessions.map(session => render(session, new Set()))}</ul>;
}
