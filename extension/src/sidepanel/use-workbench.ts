import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { OpenCodeV1Client } from "../agents/opencode-v1/client";
import { initialWorkbench, workbenchReducer, bridgeRequest, operationBindings, type Data, type UiMessage } from "./workbench-state";

export function useWorkbench() {
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbench);
  const [profiles, setProfiles] = useState<Data[]>([]), [profileId, setProfileId] = useState("");
  const [runtime, setRuntime] = useState<Data>(), [directory, setDirectory] = useState("");
  const [sessions, setSessions] = useState<Data[]>([]), [sessionId, setSessionId] = useState("");
  const [knownSessions, setKnownSessions] = useState<Record<string, Data>>({}), [sessionsLoading, setSessionsLoading] = useState(false), [hasMoreSessions, setHasMoreSessions] = useState(false);
  const sessionQuery = useRef({ search: "", limit: 50 }), sessionListRevision = useRef(0), knownRef = useRef(knownSessions);
  knownRef.current = knownSessions;
  const [catalog, setCatalog] = useState<Data>({ all: [], connected: [], default: {} });
  const [agents, setAgents] = useState<Data[]>([]), [commands, setCommands] = useState<Data[]>([]), [skills, setSkills] = useState<Data[]>([]);
  const [todos, setTodos] = useState<Data[]>([]), [children, setChildren] = useState<Data[]>([]), [diff, setDiff] = useState<Data[]>([]), [mcp, setMcp] = useState<Data>({});
  const [connected, setConnected] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const client = useRef<OpenCodeV1Client | undefined>(undefined), epoch = useRef(0), stream = useRef<AbortController | undefined>(undefined), selected = useRef("");
  const syncing = useRef(false), buffered = useRef<Data[]>([]), refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), listTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bindings = useRef(new Map<string, { client: OpenCodeV1Client; sessionID: string; profileId: string; directory: string }>());
  const recentSessions = useRef(new Map<string, string>()), metadataRevision = useRef(0);
  const responseWatch = useRef({ epoch: 0, sessionID: "", until: 0 }), latestState = useRef(state);
  latestState.current = state;
  const [watchRevision, setWatchRevision] = useState(0);
  // Child lists keyed by parent ID. A missing key means "not checked yet", so the tree shows no toggle.
  const [childIndex, setChildIndex] = useState<Record<string, Data[]>>({});
  const childQueue = useRef<string[]>([]), childRequested = useRef(new Set<string>()), childActive = useRef(0);
  const lastMessageEvent = useRef(new Map<string, number>());
  const currentProfile = useRef(""), selectionRevision = useRef(0);
  const captureScope = useCallback(() => { const revision = epoch.current, selection = selectionRevision.current; return () => revision === epoch.current && selection === selectionRevision.current; }, []);
  const fail = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
  const mergeSessions = (items: Data[]) => setKnownSessions(previous => { const next = { ...previous }; for (const item of items) if (typeof item?.id === "string") next[item.id] = item; return next; });
  const refreshSessions = useCallback(async (search?: string) => {
    const api = client.current, revision = epoch.current; if (!api) return;
    if (search !== undefined) sessionQuery.current = { search, limit: 50 };
    const query = { ...sessionQuery.current }, request = ++sessionListRevision.current;
    setSessionsLoading(true);
    try {
      const next = await api.get<Data[]>("/session", { roots: true, limit: query.limit, ...(query.search ? { search: query.search } : {}) });
      if (revision !== epoch.current || request !== sessionListRevision.current) return;
      const roots = next.filter(session => !session.parentID);
      setSessions(roots); mergeSessions(roots); setHasMoreSessions(roots.length >= query.limit);
    } finally { if (revision === epoch.current && request === sessionListRevision.current) setSessionsLoading(false); }
  }, []);
  const loadMoreSessions = useCallback(async () => { sessionQuery.current = { ...sessionQuery.current, limit: sessionQuery.current.limit + 50 }; await refreshSessions(); }, [refreshSessions]);
  const loadChildren = useCallback(async (id: string) => {
    const api = client.current, revision = epoch.current; if (!api) return [];
    const list = await api.get<Data[]>(`/session/${encodeURIComponent(id)}/children`);
    if (revision !== epoch.current) return [];
    mergeSessions(list); setChildIndex(previous => ({ ...previous, [id]: list })); return list;
  }, []);
  const pumpChildren = useCallback(() => {
    while (childActive.current < 4 && childQueue.current.length) {
      const id = childQueue.current.shift()!, api = client.current, revision = epoch.current;
      if (!api) return;
      childActive.current++;
      void api.get<Data[]>(`/session/${encodeURIComponent(id)}/children`).then(list => {
        if (revision !== epoch.current) return;
        mergeSessions(list); setChildIndex(previous => previous[id] ? previous : { ...previous, [id]: list });
      }).catch(() => { /* Unknown stays without a toggle; selecting the session still works. */ }).finally(() => {
        if (revision !== epoch.current) return;
        childActive.current--; pumpChildren();
      });
    }
  }, []);
  // The v1 Session has no child count, so only rendered rows are checked, a few at a time, once per connection.
  const ensureChildren = useCallback((ids: string[]) => {
    for (const id of ids) if (!childRequested.current.has(id)) { childRequested.current.add(id); childQueue.current.push(id); }
    pumpChildren();
  }, [pumpChildren]);
  const isSelectedOrAncestor = (id: string) => {
    for (let current = selected.current, depth = 0; current && depth < 50; current = knownRef.current[current]?.parentID ?? "", depth++) if (current === id) return true;
    return false;
  };
  const updateSession = useCallback((info: Data) => {
    if (typeof info?.id !== "string") return;
    mergeSessions([info]);
    // Events carry the full Session, so replace rather than merge: a cleared `revert` must disappear.
    setSessions(previous => previous.map(session => session.id === info.id ? info : session));
    if (info.parentID) setChildIndex(previous => previous[info.parentID] ? { ...previous, [info.parentID]: previous[info.parentID]!.map(child => child.id === info.id ? info : child) } : previous);
  }, []);
  const removeSession = useCallback((id: string) => {
    const clearSelection = isSelectedOrAncestor(id);
    setSessions(previous => previous.filter(session => session.id !== id));
    setKnownSessions(previous => { const next = { ...previous }; delete next[id]; return next; });
    setChildIndex(previous => { const next: Record<string, Data[]> = {}; for (const [parent, list] of Object.entries(previous)) if (parent !== id) next[parent] = list.filter(child => child.id !== id); return next; });
    setChildren(previous => previous.filter(child => child.id !== id));
    dispatch({ type: "forget", sessionID: id });
    if (clearSelection) {
      selectionRevision.current++; selected.current = ""; setSessionId(""); setTodos([]); setChildren([]); setDiff([]);
      void chrome.storage.local.set({ [`recentSession:${currentProfile.current}`]: "" }).catch(() => {});
    }
  }, []);
  const remember = (messages: UiMessage[], api: OpenCodeV1Client) => { for (const [operationID, sessionID] of Object.entries(operationBindings(messages))) bindings.current.set(operationID, { client: api, sessionID, profileId: currentProfile.current, directory: api.directory }); };
  const resync = useCallback(async (refreshDetails = true) => {
    const api = client.current, revision = epoch.current, id = selected.current;
    if (!api || syncing.current) return;
    syncing.current = true; buffered.current = [];
    try {
      if (refreshDetails) void refreshSessions().catch(value => { if (revision === epoch.current) fail(value); });
      const requests = [api.get<Data[]>("/question"), api.get<Data[]>("/permission"), api.get<Data>("/session/status")];
      const [questions, permissions, statuses] = await Promise.all(requests);
      if (revision !== epoch.current) return;
      dispatch({ type: "pending", questions, permissions }); dispatch({ type: "statuses", statuses });
      if (id) {
        // Optional metadata must not hold the message snapshot or the SSE buffer open.
        // A diff can stay pending while OpenCode is working, even as text is streaming.
        const metadata = refreshDetails ? ++metadataRevision.current : metadataRevision.current;
        if (refreshDetails) void api.get<Data>(`/session/${encodeURIComponent(id)}`).then(info => {
          if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current && info?.id === id) mergeSessions([info]);
        }).catch(value => { if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current) fail(value); });
        if (refreshDetails) for (const [path, update] of [["todo", setTodos], ["children", setChildren], ["diff", setDiff]] as const) {
          void api.get<Data[]>(`/session/${encodeURIComponent(id)}/${path}`).then(value => {
            if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current) update(value);
          }).catch(value => { if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current) fail(value); });
        }
        const messages = await api.get<UiMessage[]>(`/session/${encodeURIComponent(id)}/message`);
        if (revision !== epoch.current || id !== selected.current) return;
        dispatch({ type: "messages", sessionID: id, messages }); remember(messages, api);
      }
    } catch (value) { if (revision === epoch.current) fail(value); }
    finally {
      if (revision === epoch.current) {
        const events = buffered.current; buffered.current = []; syncing.current = false;
        // Snapshot timing cannot establish whether a delta is already included. Replay
        // authoritative updates; reconcile buffered deltas with another snapshot instead
        // of appending them twice to the newly fetched message text.
        for (const event of events) if (event.type !== "message.part.delta") dispatch({ type: "event", event });
        if (events.some(event => event.type === "message.part.delta")) { clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => void resync(), 300); }
      }
    }
  }, [refreshSessions]);
  const watchResponse = useCallback(() => {
    responseWatch.current = { epoch: epoch.current, sessionID: selected.current, until: Date.now() + 15_000 };
    setWatchRevision(value => value + 1);
  }, []);
  useEffect(() => {
    const revision = epoch.current, id = sessionId;
    const needsRefresh = () => {
      const status = latestState.current.statuses[id]?.type, watch = responseWatch.current;
      return !!id && (status === "busy" || status === "retry" || watch.epoch === revision && watch.sessionID === id && watch.until > Date.now());
    };
    if (!client.current || !needsRefresh()) return;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!active || revision !== epoch.current || id !== selected.current) return;
      // Streaming already delivers this session's messages; poll only when the stream has gone quiet.
      if (document.visibilityState !== "hidden" && Date.now() - (lastMessageEvent.current.get(id) ?? 0) > 1_500) await resync(false);
      if (active && needsRefresh()) timer = setTimeout(() => void tick(), 2_000);
    };
    timer = setTimeout(() => void tick(), 2_000);
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, runtime, state.statuses[sessionId]?.type, watchRevision, resync]);
  useEffect(() => {
    const restore = () => { if (document.visibilityState !== "hidden" && client.current && selected.current) void resync(false); };
    document.addEventListener("visibilitychange", restore); window.addEventListener("focus", restore);
    return () => { document.removeEventListener("visibilitychange", restore); window.removeEventListener("focus", restore); };
  }, [resync]);
  const connect = useCallback(async (id: string, workdir?: string, restoreId?: string) => {
    const restored = restoreId ?? (id !== currentProfile.current ? recentSessions.current.get(id) : undefined) ?? "";
    if (currentProfile.current && selected.current) recentSessions.current.set(currentProfile.current, selected.current);
    const revision = ++epoch.current; stream.current?.abort(); clearTimeout(refreshTimer.current); syncing.current = false; buffered.current = [];
    setLoading(true); setConnected(false); setError(""); setProfileId(id); currentProfile.current = id;
    sessionQuery.current = { search: "", limit: 50 }; sessionListRevision.current++; setKnownSessions({}); setHasMoreSessions(false); setSessionsLoading(false);
    childQueue.current = []; childRequested.current.clear(); childActive.current = 0; setChildIndex({}); lastMessageEvent.current.clear();
    selected.current = restored; setSessionId(restored); dispatch({ type: "reset" }); setSessions([]); setTodos([]); setChildren([]); setDiff([]); setCatalog({ all: [], connected: [], default: {} }); setAgents([]); setCommands([]); setSkills([]); setMcp({}); setRuntime(undefined); client.current = undefined;
    try {
      const info = await bridgeRequest("runtime.ensure", { profileId: id });
      if (revision !== epoch.current) return;
      if (info.state !== "ready" || !info.baseUrl) throw new Error(info.error ?? "OpenCode 실행 환경을 준비하지 못했습니다.");
      const actualDirectory = workdir || info.directory;
      const api = new OpenCodeV1Client({ baseUrl: info.baseUrl, username: info.username, password: info.password, directory: actualDirectory });
      client.current = api; setDirectory(actualDirectory); setRuntime({ profileId: id, state: info.state, baseUrl: info.baseUrl, version: info.version, owned: info.owned, attachCommand: info.attachCommand });
      const controller = new AbortController(); stream.current = controller;
      void api.events(event => {
        if (revision !== epoch.current) return;
        if (syncing.current) buffered.current.push(event);
        else dispatch({ type: "event", event });
        const properties = event.properties as Data, part = properties.part;
        if (part?.type === "tool") remember([{ info: { sessionID: part.sessionID }, parts: [part] }], api);
        if (event.type.startsWith("message.")) { const sessionID = properties.sessionID ?? properties.info?.sessionID ?? part?.sessionID; if (sessionID) lastMessageEvent.current.set(sessionID, Date.now()); }
        // Session and todo events carry the new state; applying them directly avoids refetching the whole conversation.
        const info = properties.info;
        if (event.type === "session.updated") updateSession(info);
        if (event.type === "session.created" && info?.id) {
          mergeSessions([info]);
          if (info.parentID) {
            setChildIndex(previous => ({ ...previous, [info.parentID]: [...(previous[info.parentID] ?? []).filter(child => child.id !== info.id), info] }));
            if (info.parentID === selected.current) setChildren(previous => [...previous.filter(child => child.id !== info.id), info]);
          } else { clearTimeout(listTimer.current); listTimer.current = setTimeout(() => void refreshSessions().catch(() => {}), 120); }
        }
        if (event.type === "session.deleted" && info?.id) removeSession(info.id);
        if (event.type === "todo.updated" && properties.sessionID === selected.current && Array.isArray(properties.todos)) setTodos(properties.todos);
      }, online => { if (revision === epoch.current) { setConnected(online); if (online) void resync(); } }, controller.signal).catch(value => { if (revision === epoch.current && !controller.signal.aborted) fail(value); });
      const results = await Promise.allSettled([api.get<Data>("/provider"), api.get<Data[]>("/agent"), api.get<Data[]>("/command"), api.get<Data[]>("/skill"), api.get<Data>("/mcp")]);
      if (revision !== epoch.current) return;
      const setters = [setCatalog, setAgents, setCommands, setSkills, setMcp] as Array<(value: any) => void>;
      results.forEach((result, index) => { if (result.status === "fulfilled") setters[index]!(result.value); else fail(result.reason); });
      await chrome.storage.local.set({ lastProfileId: id });
      await resync();
    } catch (value) { if (revision === epoch.current) fail(value); }
    finally { if (revision === epoch.current) setLoading(false); }
  }, [resync, refreshSessions, updateSession, removeSession]);
  const selectSession = useCallback(async (session: Data) => {
    selectionRevision.current++;
    if (session.directory && session.directory !== client.current?.directory) { await connect(currentProfile.current, session.directory, session.id); return; }
    mergeSessions([session]); selected.current = session.id; setSessionId(session.id); setTodos([]); setChildren([]); setDiff([]); setError("");
    await chrome.storage.local.set({ [`recentSession:${currentProfile.current}`]: session.id });
    // Any in-flight resync finishes without committing a different session; then retry.
    while (syncing.current) await new Promise(resolve => setTimeout(resolve, 20));
    await resync();
  }, [connect, resync]);
  useEffect(() => {
    let active = true;
    const load = async (changedId?: string) => {
      try {
        const result = await bridgeRequest("profile.list"); if (!active) return;
        const list = result.profiles ?? []; setProfiles(list);
        const saved = await chrome.storage.local.get("lastProfileId");
        const id = list.some((p: Data) => p.id === saved.lastProfileId) ? saved.lastProfileId : result.defaultProfileId;
        if (client.current && !list.some((profile: Data) => profile.id === currentProfile.current)) {
          epoch.current++; stream.current?.abort(); client.current = undefined; selected.current = ""; currentProfile.current = "";
          setConnected(false); setRuntime(undefined); setProfileId(""); setSessionId(""); setSessions([]); setCatalog({ all: [], connected: [], default: {} }); dispatch({ type: "reset" });
        }
        if (changedId && changedId === currentProfile.current && client.current) { await connect(changedId); return; }
        if (!client.current && id && active) { const recent = await chrome.storage.local.get(`recentSession:${id}`); if (active) await connect(id, undefined, typeof recent[`recentSession:${id}`] === "string" ? recent[`recentSession:${id}`] as string : undefined); }
      } catch (value) { if (active) fail(value); }
    };
    void load();
    const listener = (message: Data) => { if (message.kind === "conn-status" && message.status?.state === "connected") void load(); if (message.kind === "profiles-changed") void load(message.profileId); };
    chrome.runtime.onMessage.addListener(listener);
    return () => { active = false; epoch.current++; stream.current?.abort(); clearTimeout(refreshTimer.current); clearTimeout(listTimer.current); chrome.runtime.onMessage.removeListener(listener); };
  }, [connect]);
  const abortKnown = useCallback(async (operationId: string) => {
    const binding = bindings.current.get(operationId); if (!binding) return false;
    await binding.client.post(`/session/${encodeURIComponent(binding.sessionID)}/abort`); return true;
  }, []);
  return { state, dispatch, profiles, profileId, runtime, directory, sessions, sessionId, session: knownSessions[sessionId], knownSessions, sessionsLoading, hasMoreSessions, loadMoreSessions, loadChildren, childIndex, ensureChildren, updateSession, removeSession, connectionRevision: epoch.current, catalog, agents, commands, skills, todos, children, diff, mcp, connected, loading, error, setError, client, captureScope, watchResponse, connect, selectSession, resync, refreshSessions, abortKnown };
}
