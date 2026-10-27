import { useEffect, useReducer, useRef, useState } from "react";
import type { ConnStatus } from "../background/bridge-connection";
import { initialPanelState, reduceStatus } from "./status-store";
import "./style.css";
import { BrowserExtras } from "./BrowserExtras";
import { Workbench, type WorkspaceView } from "./Workbench";

function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: string; code?: string };
    if (e.code === "BROWSER_BUSY") return "진행 중인 작업을 종료하거나 중단한 후 브라우저를 선택하세요.";
    return e.message || e.code || "요청을 완료하지 못했습니다.";
  }
  return String(error || "요청을 완료하지 못했습니다.");
}

async function request(method: string, params: Record<string, unknown> = {}) {
  const response = await chrome.runtime.sendMessage({ kind: "bridge", method, params });
  if (!response?.ok) throw response?.error ?? new Error("브리지 응답을 받지 못했습니다.");
  return response.result;
}

function connectionLabel(conn: ConnStatus) {
  switch (conn.state) {
    case "connected": return "연결됨";
    case "connecting": return "연결 중";
    case "unpaired": case "not_paired": return "페어링 필요";
    case "auth_failed": return "페어링 인증 실패";
    default: return conn.retryInMs ? `끊김 · ${Math.ceil(conn.retryInMs / 1000)}초 후 재시도` : "연결 끊김";
  }
}

type TabInfo = { id: number; title: string; url?: string };

export function App() {
  const [state, dispatch] = useReducer(reduceStatus, initialPanelState);
  const [clientId, setClientId] = useState<string>();
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [view, setView] = useState<WorkspaceView>("chat");
  const refresh = useRef<() => Promise<void>>(async () => {});
  const mounted = useRef(false);
  const stopHandler = useRef<(operationId: string) => Promise<void>>(async () => {});

  useEffect(() => {
    mounted.current = true;
    let active = true, revision = 0, connectionRevision = 0;
    const load = async () => {
      const before = revision;
      try {
        const data = await request("status.get");
        if (active && before === revision) dispatch({ kind: "bridge-event", event: "status.changed", data });
      } catch (error) { if (active && before === revision) dispatch({ kind: "request-failed", message: errorText(error) }); }
    };
    refresh.current = load;
    const listener = (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const message = msg as { kind?: string; event?: string; status?: ConnStatus };
      if (message.kind !== "conn-status" && !(message.kind === "bridge-event" && message.event === "status.changed")) return;
      revision++;
      dispatch(message);
      if (message.kind === "conn-status") {
        connectionRevision++;
        setSelecting(false);
        if (message.status?.state === "connected") void load();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    void chrome.storage.local.get("clientId").then((saved) => { if (active && typeof saved.clientId === "string") setClientId(saved.clientId); })
      .catch((error) => { if (active) dispatch({ kind: "request-failed", message: errorText(error) }); });
    const before = connectionRevision;
    void chrome.runtime.sendMessage({ kind: "get-conn-status" }).then((status: ConnStatus) => {
      if (!active || before !== connectionRevision) return;
      dispatch({ kind: "conn-status", status });
      if (status.state === "connected") void load();
    }).catch((error) => { if (active) dispatch({ kind: "request-failed", message: errorText(error) }); });
    return () => { active = false; mounted.current = false; chrome.runtime.onMessage.removeListener(listener); };
  }, []);

  const op = state.operation;
  const localOperation = !!clientId && !!op && op.clientId === clientId;
  const tabKey = op ? [...new Set([...op.tabs, op.currentTab])].join(",") : "";
  useEffect(() => {
    let active = true, revision = 0;
    setTabs([]);
    if (!localOperation || !tabKey) return;
    const ids = tabKey.split(",").map(Number);
    const load = async () => {
      const current = ++revision;
      const next = await Promise.all(ids.map(async (id): Promise<TabInfo> => {
        try { const tab = await chrome.tabs.get(id); return { id, title: tab.title || `탭 ${id}`, url: tab.url }; }
        catch { return { id, title: `닫힌 탭 (${id})` }; }
      }));
      if (active && current === revision) setTabs(next);
    };
    const changed = (tabId: number) => { if (ids.includes(tabId)) void load(); };
    chrome.tabs.onUpdated.addListener(changed);
    chrome.tabs.onRemoved.addListener(changed);
    void load();
    return () => { active = false; chrome.tabs.onUpdated.removeListener(changed); chrome.tabs.onRemoved.removeListener(changed); };
  }, [localOperation, tabKey, op?.id]);

  const stop = async () => {
    if (!op || state.stopping) return;
    dispatch({ kind: "stop-requested" });
    try {
      const result = await request("operation.abort", { operationId: op.id });
      if (!mounted.current) return;
      dispatch({ kind: "stop-completed", operationId: op.id, confirmed: result?.aborted === true });
      if (result?.aborted === true) await stopHandler.current(op.id);
      await refresh.current();
    } catch (error) { if (mounted.current) dispatch({ kind: "request-failed", message: errorText(error) }); }
  };
  const select = async () => {
    if (!clientId || selecting) return;
    setSelecting(true); dispatch({ kind: "clear-error" });
    try { await request("browser.use", { clientId }); if (mounted.current) await refresh.current(); }
    catch (error) { if (mounted.current) dispatch({ kind: "request-failed", message: errorText(error) }); }
    finally { if (mounted.current) setSelecting(false); }
  };
  const connected = state.conn.state === "connected";
  const selected = state.browsers.find((browser) => browser.clientId === clientId)?.selected;

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M3 9h18M9 9v12" /></svg><div><h1>AgentBrowser</h1><div className={`connection ${connected ? "online" : "offline"}`} role="status"><span className="dot" />{connectionLabel(state.conn)}</div></div></div>
      <div className="header-actions"><button className="quiet" onClick={() => void chrome.runtime.openOptionsPage()}>설정</button><button className="stop" aria-label="브라우저 작업 중단" disabled={!connected || !op || state.stopping} onClick={() => void stop()}>{state.stopping ? "중단 중…" : "중단"}</button></div>
    </header>
    {(state.conn.detail || state.error || state.stopped) && <div className="global-notices">
      {state.conn.detail && <p className="muted">{state.conn.detail}</p>}
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {state.stopped && <p className="notice" role="status">중단됨: 이후 브라우저 조작이 차단되었습니다. 이미 제출된 웹사이트 요청은 취소되지 않습니다.</p>}
    </div>}
    <nav className="app-tabs" role="tablist" aria-label="작업 공간 보기" onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const views: WorkspaceView[] = ["chat", "sessions", "browser"], position = views.indexOf(view);
      const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (position + (event.key === "ArrowRight" ? 1 : 2)) % 3;
      event.preventDefault(); setView(views[next]!); event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    }}>
      {([["chat", "대화"], ["sessions", "세션"], ["browser", "브라우저"]] as const).map(([id, label]) => <button key={id} id={`tab-${id}`} role="tab" aria-controls={`view-${id}`} aria-selected={view === id} tabIndex={view === id ? 0 : -1} onClick={() => setView(id)}>{label}</button>)}
    </nav>
    <div className="app-content">
    <Workbench operation={op} stopHandler={stopHandler} view={view} onViewChange={setView} />
    <div id="view-browser" className="browser-view view-scroll" role="tabpanel" aria-labelledby="tab-browser" hidden={view !== "browser"}>
      <div className="view-heading"><div><span className="eyebrow">BROWSER</span><h2>브라우저 작업</h2></div><span className={`status-pill ${op ? "busy" : ""}`}>{op ? "작업 진행 중" : "대기"}</span></div>
    {state.browsers.length > 1 && <section aria-label="브라우저 선택">
      <h2>연결된 브라우저</h2>
      <ul>{state.browsers.map((browser) => <li key={browser.clientId}>{browser.clientId === clientId ? "이 브라우저" : browser.clientId} · {browser.connected ? "연결됨" : "끊김"}{browser.selected ? " · 선택됨" : ""}</li>)}</ul>
      <button onClick={() => void select()} disabled={!connected || !clientId || selected || selecting || !!op}>{selecting ? "선택 중…" : "이 브라우저 사용"}</button>
      {!!op && !selected && <p className="muted">작업을 종료하거나 중단한 후 선택할 수 있습니다.</p>}
    </section>}
    <section aria-label="현재 작업">
      <div className="section-heading"><h2>현재 작업</h2></div>
      {op ? <>
        <p className="muted operation-id">{op.id} · 작업 탭 {op.tabs.length}개</p>
        {localOperation ? <ul className="tabs">{tabs.map((tab) => <li key={tab.id}><strong>{tab.id === op.currentTab ? "현재 · " : ""}{tab.title}</strong>{tab.url && <span className="url">{tab.url}</span>}</li>)}</ul> : <p>다른 브라우저의 작업 탭 · {op.currentTab}</p>}
      </> : <p className="muted">{connected ? "진행 중인 작업이 없습니다." : "브리지 연결 후 작업 상태를 확인할 수 있습니다."}</p>}
    </section>
    {localOperation&&op&&<BrowserExtras operationId={op.id} visible={view==="browser"} />}
    <section aria-label="최근 작업 기록"><h2>최근 작업 기록</h2>
      {state.timeline.length ? <ol className="timeline">{[...state.timeline].reverse().map((entry, index) => <li key={`${entry.atMs}-${index}`}><div><time>{new Date(entry.atMs).toLocaleTimeString("ko-KR")}</time><span className={entry.outcome === "ok" ? "outcome" : "outcome failed"}>{entry.outcome}</span></div><strong>{entry.tool}</strong>{entry.summary && <p>{entry.summary}</p>}</li>)}</ol> : <p className="muted">아직 기록이 없습니다.</p>}
    </section>
    </div>
    </div>
  </main>;
}
