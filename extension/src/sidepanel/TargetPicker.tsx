import { useEffect, useRef, useState } from "react";
import { listRequestTargets, type TargetChoice } from "./request-target";

const AUTO = "자동";
const windowLabel = (win: TargetChoice, normalIndex: number) =>
  (win.type === "popup" ? "팝업 창" : `창 ${normalIndex}`) + (win.focused ? " · 현재 창" : "");

/** Chooses the tab the next request works on, including tabs of popup-type windows that have no toolbar.
 * Empty means the automatic capture at send time, unchanged. The choice lives only in this panel. */
export function TargetPicker({ chosen, onChange }: { chosen: number | null; onChange(tabId: number | null, closed?: boolean): void }) {
  const [windows, setWindows] = useState<TargetChoice[]>([]);
  const chosenRef = useRef(chosen); chosenRef.current = chosen;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  useEffect(() => {
    let active = true, latest = 0, timer: ReturnType<typeof setTimeout> | undefined, first: number | undefined;
    // Only the newest read may replace the list, so a slow older read cannot bring back a closed tab.
    const load = () => { const read = ++latest; first = undefined; void listRequestTargets().then(list => { if (active && read === latest) setWindows(list); }, () => {}); };
    // Page loads fire many tab updates; one read after they settle is enough, but at most a second late.
    const later = () => {
      clearTimeout(timer); first ??= Date.now();
      timer = setTimeout(load, Math.max(0, Math.min(300, first + 1000 - Date.now())));
    };
    const removed = (tabId: number) => { if (tabId === chosenRef.current) changeRef.current(null, true); later(); };
    const events: Array<[chrome.events.Event<any> | undefined, (...args: any[]) => void]> = [
      [chrome.tabs?.onCreated, later], [chrome.tabs?.onUpdated, later], [chrome.tabs?.onRemoved, removed],
      [chrome.tabs?.onAttached, later], [chrome.tabs?.onDetached, later],
      [chrome.windows?.onCreated, later], [chrome.windows?.onRemoved, later], [chrome.windows?.onFocusChanged, later],
    ];
    load();
    for (const [event, listener] of events) event?.addListener(listener);
    return () => { active = false; clearTimeout(timer); for (const [event, listener] of events) event?.removeListener(listener); };
  }, []);
  let normal = 0;
  const known = chosen !== null && windows.some(win => win.tabs.some(tab => tab.tabId === chosen));
  const title = chosen === null ? "자동: 보낼 때 보고 있는 탭" : `작업 대상: ${windows.flatMap(win => win.tabs).find(tab => tab.tabId === chosen)?.title || "선택한 탭"}`;
  return <span className="target-picker" title={title}><span aria-hidden="true">대상</span><select aria-label="작업 대상" value={chosen === null ? "" : String(chosen)}
    onChange={event => onChange(event.target.value === "" ? null : Number(event.target.value))}>
    <option value="">{AUTO}</option>
    {windows.map(win => <optgroup key={win.windowId} label={windowLabel(win, win.type === "popup" ? normal : ++normal)}>
      {win.tabs.map(tab => <option key={tab.tabId} value={String(tab.tabId)}>{tab.title || new URL(tab.url).host}</option>)}
    </optgroup>)}
    {chosen !== null && !known && <option value={String(chosen)}>선택한 탭(지금 쓸 수 없음)</option>}
  </select></span>;
}
