import { useEffect, useRef, useState } from "react";
import type { Data } from "./workbench-state";

type Props = { sessions: Data[]; selectedId: string; statuses: Record<string, Data>; loadChildren: (id: string) => Promise<Data[]>; onSelect: (session: Data) => void };
export function SessionTree({ sessions, selectedId, statuses, loadChildren, onSelect }: Props) {
  const [expanded, setExpanded] = useState(new Set<string>()), [children, setChildren] = useState<Record<string, Data[]>>({});
  const [loading, setLoading] = useState(new Set<string>()), [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true), pending = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function toggle(id: string) {
    if (expanded.has(id)) { setExpanded(previous => { const next = new Set(previous); next.delete(id); return next; }); return; }
    setExpanded(previous => new Set(previous).add(id));
    if (pending.current.has(id)) return;
    pending.current.add(id); setLoading(previous => new Set(previous).add(id));
    setErrors(previous => { const next = { ...previous }; delete next[id]; return next; });
    try { const rows = await loadChildren(id); if (mounted.current) setChildren(previous => ({ ...previous, [id]: rows })); }
    catch (error) { if (mounted.current) setErrors(previous => ({ ...previous, [id]: error instanceof Error ? error.message : String(error) })); }
    finally { pending.current.delete(id); if (mounted.current) setLoading(previous => { const next = new Set(previous); next.delete(id); return next; }); }
  }
  const render = (session: Data, ancestry: Set<string>): React.ReactNode => {
    if (ancestry.has(session.id)) return null;
    const path = new Set(ancestry).add(session.id), open = expanded.has(session.id), childId = `session-children-${session.id}`;
    return <li key={session.id}><div className="session-row">
      <button className="tree-toggle" aria-label={`${session.title} 하위 세션 ${open ? "접기" : "펼치기"}`} aria-expanded={open} aria-controls={childId} onClick={() => void toggle(session.id)}>{open ? "⌄" : "›"}</button>
      <button className={`session-open ${session.id === selectedId ? "selected" : ""}`} aria-current={session.id === selectedId ? "true" : undefined} onClick={() => onSelect(session)}><strong>{session.title}</strong><small>{session.directory}</small><small>{statuses[session.id]?.type === "busy" ? "실행 중인 작업에 연결" : session.parentID ? "하위 세션 열기" : "저장된 대화 열기"} · {session.time?.updated ? new Date(session.time.updated).toLocaleString("ko-KR") : ""}</small></button>
    </div>{open && <div id={childId} className="session-children">
      {loading.has(session.id) && <p className="muted" role="status">하위 세션을 불러오는 중…</p>}
      {errors[session.id] && <p role="alert" className="error">{errors[session.id]} 다시 펼쳐 재시도하세요.</p>}
      {children[session.id]?.length === 0 && <p className="muted">하위 세션이 없습니다.</p>}
      {!!children[session.id]?.length && <ul>{children[session.id]!.map(child => render(child, path))}</ul>}
    </div>}</li>;
  };
  return <ul className="session-list session-tree">{sessions.map(session => render(session, new Set()))}</ul>;
}
