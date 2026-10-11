import { useEffect, useRef, useState } from "react";
import { shouldSubmit } from "./workbench-state";

export type SessionAction = { label: string; run: () => void; confirm?: string };

/** Per-session actions stay behind one button so rows and the conversation title remain readable. */
export function SessionMenu({ label, actions }: { label: string; actions: SessionAction[] }) {
  const [open, setOpen] = useState(false), [confirming, setConfirming] = useState<SessionAction>();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const close = (refocus = false) => { setOpen(false); setConfirming(undefined); if (refocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => { if (open) root.current?.querySelector<HTMLButtonElement>(".session-menu-popover button")?.focus(); }, [open, confirming]);
  const choose = (action: SessionAction) => { if (action.confirm) { setConfirming(action); return; } close(); action.run(); };
  return <div className="session-menu" ref={root} onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    <button ref={trigger} type="button" className="quiet session-menu-trigger" aria-label={label} aria-expanded={open} aria-haspopup="true" onClick={() => open ? close() : setOpen(true)}>⋯</button>
    {open && <div className="session-menu-popover">
      {confirming ? <>
        <p>{confirming.confirm}</p>
        <button type="button" className="stop" onClick={() => { const action = confirming; close(); action.run(); }}>{confirming.label} 확인</button>
        <button type="button" onClick={() => setConfirming(undefined)}>취소</button>
      </> : actions.map(action => <button type="button" key={action.label} className={action.confirm ? "danger-text" : undefined} onClick={() => choose(action)}>{action.label}</button>)}
    </div>}
  </div>;
}

/** Enter saves, Escape cancels; Enter while composing Hangul only finishes the syllable. */
export function RenameField({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial), done = useRef(false), composing = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return; done.current = true;
    const title = value.trim();
    if (save && title && title !== initial) onSubmit(title); else onCancel();
  };
  return <input className="rename-field" aria-label="세션 이름" autoFocus value={value} onChange={event => setValue(event.target.value)}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
      else if (!composing.current && shouldSubmit(event.nativeEvent)) { event.preventDefault(); finish(true); }
    }} onBlur={() => finish(true)} />;
}
