import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { OpenCodeApiError, OpenCodeV1Client } from "../agents/opencode-v1/client";
import { initialWorkbench, workbenchReducer, bridgeRequest, operationBindings, sameMessage, type Data, type UiMessage } from "./workbench-state";
import { bridgeUnavailable } from "./error-text";

// An event stream that stays down this long is treated as a restarted or stopped server.
const OFFLINE_RECOVERY_MS = 5_000;
const FULL_POLL_EVERY = 5;
const STREAM_LOST = "OpenCode 서버와 연결이 끊겼습니다. 서버 상태를 확인한 뒤 다시 시도하세요.";
const SERVER_STOPPED = "설정에서 이 실행 환경의 서버를 중지했습니다. 다시 사용하려면 [다시 시도]를 누르세요.";

export function useWorkbench() {
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbench);
  const [profiles, setProfiles] = useState<Data[]>([]), [profilesLoaded, setProfilesLoaded] = useState(false), [profileId, setProfileId] = useState("");
  const [runtime, setRuntime] = useState<Data>(), [directory, setDirectory] = useState("");
  const [sessions, setSessions] = useState<Data[]>([]), [sessionId, setSessionId] = useState("");
  const [knownSessions, setKnownSessions] = useState<Record<string, Data>>({}), [sessionsLoading, setSessionsLoading] = useState(false), [hasMoreSessions, setHasMoreSessions] = useState(false);
  const sessionQuery = useRef({ search: "", limit: 50 }), sessionListRevision = useRef(0), knownRef = useRef(knownSessions);
  knownRef.current = knownSessions;
  const deletedSessions = useRef(new Set<string>());
  const [catalog, setCatalog] = useState<Data>({ all: [], connected: [], default: {} });
  const [agents, setAgents] = useState<Data[]>([]), [commands, setCommands] = useState<Data[]>([]), [skills, setSkills] = useState<Data[]>([]);
  const [todos, setTodos] = useState<Data[]>([]), [children, setChildren] = useState<Data[]>([]), [diff, setDiff] = useState<Data[]>([]), [mcp, setMcp] = useState<Data>({});
  const [connected, setConnected] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const client = useRef<OpenCodeV1Client | undefined>(undefined), epoch = useRef(0), stream = useRef<AbortController | undefined>(undefined), selected = useRef("");
  const syncing = useRef(false), buffered = useRef<Data[]>([]), refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), listTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bindings = useRef(new Map<string, { client: OpenCodeV1Client; sessionID: string; profileId: string; directory: string }>());
  const recentSessions = useRef(new Map<string, string>()), metadataRevision = useRef(0);
  const responseWatch = useRef({ epoch: 0, sessionID: "", until: 0 }), latestState = useRef(state), lightPolls = useRef(0);
  latestState.current = state;
  const [watchRevision, setWatchRevision] = useState(0);
  // Child lists keyed by parent ID. A missing key means "not checked yet", so the tree shows no toggle.
  const [childIndex, setChildIndex] = useState<Record<string, Data[]>>({});
  const childGeneration = useRef(0), [childFreshness, setChildFreshness] = useState(0);
  const childQueue = useRef<string[]>([]), childRequested = useRef(new Set<string>()), childActive = useRef(0);
  const lastMessageEvent = useRef(new Map<string, number>()), rerunDetails = useRef(false), previousStatus = useRef({ id: "", type: undefined as string | undefined });
  const currentProfile = useRef(""), selectionRevision = useRef(0);
  // A failed event stream gets one automatic runtime.ensure; a second failure before the stream is back waits for the user.
  const autoRecovered = useRef(false), offlineTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), streamOnline = useRef(false);
  const reconnect = useRef<(id: string, workdir?: string, restoreId?: string, automatic?: boolean) => Promise<void>>(async () => {});
  const captureScope = useCallback(() => { const revision = epoch.current, selection = selectionRevision.current; return () => revision === epoch.current && selection === selectionRevision.current; }, []);
  const fail = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
  const mergeSessions = (items: Data[]) => setKnownSessions(previous => { const next = { ...previous }; for (const item of items) if (typeof item?.id === "string" && !deletedSessions.current.has(item.id)) next[item.id] = item; return next; });
  const refreshSessions = useCallback(async (search?: string) => {
    const api = client.current, revision = epoch.current; if (!api) return;
    if (search !== undefined) sessionQuery.current = { search, limit: 50 };
    const query = { ...sessionQuery.current }, request = ++sessionListRevision.current;
    setSessionsLoading(true);
    try {
      const next = await api.get<Data[]>("/session", { roots: true, limit: query.limit, ...(query.search ? { search: query.search } : {}) });
      if (revision !== epoch.current || request !== sessionListRevision.current) return;
      const roots = next.filter(session => !session.parentID && !deletedSessions.current.has(session.id));
      setSessions(roots); mergeSessions(roots); setHasMoreSessions(next.length >= query.limit);
    } finally { if (revision === epoch.current && request === sessionListRevision.current) setSessionsLoading(false); }
  }, []);
  const loadMoreSessions = useCallback(async () => { sessionQuery.current = { ...sessionQuery.current, limit: sessionQuery.current.limit + 50 }; await refreshSessions(); }, [refreshSessions]);
  const loadChildren = useCallback(async (id: string) => {
    const api = client.current, revision = epoch.current, generation = childGeneration.current; if (!api) return [];
    const list = (await api.get<Data[]>(`/session/${encodeURIComponent(id)}/children`)).filter(child => !deletedSessions.current.has(child.id));
    if (revision !== epoch.current || generation !== childGeneration.current || deletedSessions.current.has(id)) return [];
    mergeSessions(list); setChildIndex(previous => ({ ...previous, [id]: list })); return list;
  }, []);
  const pumpChildren = useCallback(() => {
    while (childActive.current < 4 && childQueue.current.length) {
      const id = childQueue.current.shift()!, api = client.current, revision = epoch.current, generation = childGeneration.current;
      if (!api) return;
      childActive.current++;
      void api.get<Data[]>(`/session/${encodeURIComponent(id)}/children`).then(list => {
        if (revision !== epoch.current || generation !== childGeneration.current || deletedSessions.current.has(id)) return;
        list = list.filter(child => !deletedSessions.current.has(child.id));
        mergeSessions(list); setChildIndex(previous => previous[id] ? previous : { ...previous, [id]: list });
      }).catch(() => {
        if (revision === epoch.current && generation === childGeneration.current) childRequested.current.delete(id);
      }).finally(() => {
        // Old generations still occupy a slot until their HTTP requests settle.
        childActive.current--; pumpChildren();
      });
    }
  }, []);
  // The v1 Session has no child count, so only rendered rows are checked, a few at a time, once per connection.
  const ensureChildren = useCallback((ids: string[]) => {
    for (const id of ids) if (!childRequested.current.has(id)) { childRequested.current.add(id); childQueue.current.push(id); }
    pumpChildren();
  }, [pumpChildren, childFreshness]);
  const invalidateChildren = useCallback(() => {
    childGeneration.current++; childQueue.current = []; childRequested.current.clear();
    setChildIndex({}); setChildFreshness(value => value + 1);
  }, []);
  const isSelectedOrAncestor = (id: string) => {
    for (let current = selected.current, depth = 0; current && depth < 50; current = knownRef.current[current]?.parentID ?? "", depth++) if (current === id) return true;
    return false;
  };
  const updateSession = useCallback((info: Data) => {
    if (typeof info?.id !== "string" || deletedSessions.current.has(info.id)) return;
    mergeSessions([info]);
    // Events carry the full Session, so replace rather than merge: a cleared `revert` must disappear.
    setSessions(previous => previous.map(session => session.id === info.id ? info : session));
    if (info.parentID) setChildIndex(previous => previous[info.parentID] ? { ...previous, [info.parentID]: previous[info.parentID]!.map(child => child.id === info.id ? info : child) } : previous);
  }, []);
  const removeSession = useCallback((id: string) => {
    deletedSessions.current.add(id);
    if (recentSessions.current.get(currentProfile.current) === id) recentSessions.current.delete(currentProfile.current);
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
  // `light` is the poll of a running response: it reads the status and the last message, and fetches the
  // whole conversation only when one of them changed or, as a safeguard, on every FULL_POLL_EVERY-th poll.
  const resync = useCallback(async (refreshDetails = true, light = false) => {
    const api = client.current, revision = epoch.current, id = selected.current;
    if (!api) return;
    // A detailed refresh requested mid-sync (e.g. the run just finished) must not be dropped.
    if (syncing.current) { if (refreshDetails) rerunDetails.current = true; return; }
    syncing.current = true; buffered.current = [];
    try {
      if (refreshDetails) void refreshSessions().catch(value => { if (revision === epoch.current) fail(value); });
      const requests = [api.get<Data[]>("/question"), api.get<Data[]>("/permission"), api.get<Data>("/session/status")] as const;
      const [questions, permissions, statuses] = await Promise.all(requests);
      if (revision !== epoch.current) return;
      // OpenCode 1.18.29 removes idle sessions from its authoritative status map.
      // Only a successful snapshot can end a previously busy/retrying run this way.
      const authoritative: Data = { ...statuses };
      for (const [session, status] of Object.entries(latestState.current.statuses)) {
        if (!(session in statuses) && (status.type === "busy" || status.type === "retry")) authoritative[session] = { type: "idle" };
      }
      const statusChanged = !!id && authoritative[id]?.type !== latestState.current.statuses[id]?.type;
      dispatch({ type: "pending", questions, permissions }); dispatch({ type: "statuses", statuses: authoritative });
      if (id) {
        const path = `/session/${encodeURIComponent(id)}/message`;
        let snapshot: UiMessage[] | undefined;
        if (light && !statusChanged && ++lightPolls.current % FULL_POLL_EVERY !== 0) {
          const latest = await api.get<UiMessage[]>(path, { limit: 1 });
          if (revision !== epoch.current || id !== selected.current) return;
          const held = latestState.current.messages[id] ?? [], last = latest[0];
          // More than one message means the server ignored the limit: that answer is the whole conversation.
          if (latest.length > 1) snapshot = latest;
          else if (last ? sameMessage(held.find(message => message.info.id === last.info?.id), last) : !held.length) return;
        }
        // Optional metadata must not hold the message snapshot or the SSE buffer open.
        // A diff can stay pending while OpenCode is working, even as text is streaming.
        const metadata = refreshDetails ? ++metadataRevision.current : metadataRevision.current;
        if (refreshDetails) void api.get<Data>(`/session/${encodeURIComponent(id)}`).then(info => {
          if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current && info?.id === id) mergeSessions([info]);
        }).catch(value => { if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current) fail(value); });
        if (refreshDetails) for (const [path, update] of [["todo", setTodos], ["children", setChildren], ["diff", setDiff]] as const) {
          void api.get<Data[]>(`/session/${encodeURIComponent(id)}/${path}`).then(value => {
            if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current) update(path === "children" ? value.filter(child => !deletedSessions.current.has(child.id)) : value);
          }).catch(value => { if (revision === epoch.current && id === selected.current && metadata === metadataRevision.current) fail(value); });
        }
        const messages = snapshot ?? await api.get<UiMessage[]>(path);
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
        const rerun = rerunDetails.current; rerunDetails.current = false;
        if (rerun || events.some(event => event.type === "message.part.delta")) { clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => void resync(), rerun ? 50 : 300); }
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
      if (document.visibilityState !== "hidden" && Date.now() - (lastMessageEvent.current.get(id) ?? 0) > 1_500) await resync(false, true);
      if (active && needsRefresh()) timer = setTimeout(() => void tick(), 2_000);
    };
    timer = setTimeout(() => void tick(), 2_000);
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, runtime, state.statuses[sessionId]?.type, watchRevision, resync]);
  // When the selected run ends, fetch once with details: the final message, todos and the file diff
  // are only guaranteed after completion, and the busy poll does not fetch them.
  const selectedStatus = state.statuses[sessionId]?.type;
  useEffect(() => {
    const previous = previousStatus.current; previousStatus.current = { id: sessionId, type: selectedStatus };
    if (previous.id === sessionId && (previous.type === "busy" || previous.type === "retry") && selectedStatus === "idle" && client.current) {
      clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => void resync(), 50);
    }
  }, [sessionId, selectedStatus, resync]);
  useEffect(() => {
    const restore = () => { if (document.visibilityState !== "hidden" && client.current && selected.current) void resync(false); };
    document.addEventListener("visibilitychange", restore); window.addEventListener("focus", restore);
    return () => { document.removeEventListener("visibilitychange", restore); window.removeEventListener("focus", restore); };
  }, [resync]);
  const connect = useCallback(async (id: string, workdir?: string, restoreId?: string, automatic = false) => {
    let restored = restoreId ?? (id !== currentProfile.current ? recentSessions.current.get(id) : undefined) ?? "";
    if (currentProfile.current && selected.current) recentSessions.current.set(currentProfile.current, selected.current);
    const revision = ++epoch.current; stream.current?.abort(); clearTimeout(refreshTimer.current); syncing.current = false; buffered.current = [];
    clearTimeout(offlineTimer.current); offlineTimer.current = undefined; streamOnline.current = false; if (!automatic) autoRecovered.current = false;
    setLoading(true); setConnected(false); setError(""); setProfileId(id); currentProfile.current = id;
    sessionQuery.current = { search: "", limit: 50 }; sessionListRevision.current++; setKnownSessions({}); setHasMoreSessions(false); setSessionsLoading(false);
    invalidateChildren(); deletedSessions.current.clear(); lastMessageEvent.current.clear();
    selected.current = restored; setSessionId(restored); dispatch({ type: "reset" }); setSessions([]); setTodos([]); setChildren([]); setDiff([]); setCatalog({ all: [], connected: [], default: {} }); setAgents([]); setCommands([]); setSkills([]); setMcp({}); setRuntime(undefined); client.current = undefined;
    try {
      const info = await bridgeRequest("runtime.ensure", { profileId: id });
      if (revision !== epoch.current) return;
      if (info.state !== "ready" || !info.baseUrl) throw new Error(info.error ?? "OpenCode 실행 환경을 준비하지 못했습니다.");
      let actualDirectory = workdir || info.directory;
      const makeClient = () => new OpenCodeV1Client({ baseUrl: info.baseUrl, username: info.username, password: info.password, directory: actualDirectory });
      let api = makeClient();
      if (restored && !workdir) {
        // Session-ID middleware resolves the session across directories. Resolve it before
        // opening instance-scoped APIs/SSE, which have no session ID to correct their scope.
        const session = await api.get<Data>(`/session/${encodeURIComponent(restored)}`).catch(value => {
          if (!(value instanceof OpenCodeApiError) || value.status !== 404) throw value;
          return undefined;
        });
        if (revision !== epoch.current) return;
        if (!session) { restored = ""; selected.current = ""; setSessionId(""); recentSessions.current.delete(id); }
        if (session?.id === restored && session.directory) { actualDirectory = session.directory; api = makeClient(); mergeSessions([session]); }
      }
      client.current = api; setDirectory(actualDirectory); setRuntime({ profileId: id, state: info.state, baseUrl: info.baseUrl, version: info.version, owned: info.owned, attachCommand: info.attachCommand });
      const controller = new AbortController(); stream.current = controller;
      // The server may have been stopped and started again with a new port or password: ask the Bridge once
      // for the current connection and keep the selected session. A repeated failure stops with its error.
      const recover = (reason: unknown) => {
        if (revision !== epoch.current || controller.signal.aborted) return;
        clearTimeout(offlineTimer.current); offlineTimer.current = undefined;
        if (autoRecovered.current) { controller.abort(); streamOnline.current = false; setConnected(false); fail(reason); return; }
        autoRecovered.current = true;
        void reconnect.current(id, api.directory, selected.current || undefined, true);
      };
      void api.events(event => {
        if (revision !== epoch.current) return;
        if (syncing.current) buffered.current.push(event);
        else dispatch({ type: "event", event });
        const properties = event.properties as Data, part = properties.part;
        if (part?.type === "tool") remember([{ info: { sessionID: part.sessionID }, parts: [part] }], api);
        if (event.type.startsWith("message.")) { const sessionID = properties.sessionID ?? properties.info?.sessionID ?? part?.sessionID; if (sessionID) lastMessageEvent.current.set(sessionID, Date.now()); }
        // Session and todo events carry the new state; applying them directly avoids refetching the whole conversation.
        const info = properties.info;
        if (event.type === "session.updated") {
          updateSession(info);
          // Activity reorders the root list; one debounced list GET keeps the order without refetching messages.
          if (info && !info.parentID) { clearTimeout(listTimer.current); listTimer.current = setTimeout(() => void refreshSessions().catch(() => {}), 1_000); }
        }
        if (event.type === "session.diff" && properties.sessionID === selected.current && Array.isArray(properties.diff)) setDiff(properties.diff);
        if (event.type === "session.created" && info?.id) {
          mergeSessions([info]);
          if (info.parentID) {
            setChildIndex(previous => ({ ...previous, [info.parentID]: [...(previous[info.parentID] ?? []).filter(child => child.id !== info.id), info] }));
            if (info.parentID === selected.current) setChildren(previous => [...previous.filter(child => child.id !== info.id), info]);
          } else { clearTimeout(listTimer.current); listTimer.current = setTimeout(() => void refreshSessions().catch(() => {}), 120); }
        }
        if (event.type === "session.deleted" && info?.id) removeSession(info.id);
        if (event.type === "todo.updated" && properties.sessionID === selected.current && Array.isArray(properties.todos)) setTodos(properties.todos);
      }, online => {
        if (revision !== epoch.current || controller.signal.aborted) return;
        setConnected(online); streamOnline.current = online;
        if (online) { clearTimeout(offlineTimer.current); offlineTimer.current = undefined; autoRecovered.current = false; invalidateChildren(); void resync(); }
        else offlineTimer.current ??= setTimeout(() => recover(new Error(STREAM_LOST)), OFFLINE_RECOVERY_MS);
      }, controller.signal).catch(value => recover(value));
      const results = await Promise.allSettled([api.get<Data>("/provider"), api.get<Data[]>("/agent"), api.get<Data[]>("/command"), api.get<Data[]>("/skill"), api.get<Data>("/mcp")]);
      if (revision !== epoch.current) return;
      const setters = [setCatalog, setAgents, setCommands, setSkills, setMcp] as Array<(value: any) => void>;
      results.forEach((result, index) => { if (result.status === "fulfilled") setters[index]!(result.value); else fail(result.reason); });
      await chrome.storage.local.set({ lastProfileId: id, [`recentSession:${id}`]: selected.current });
      await resync();
    } catch (value) { if (revision === epoch.current) fail(value); }
    finally { if (revision === epoch.current) setLoading(false); }
  }, [resync, refreshSessions, updateSession, removeSession, invalidateChildren]);
  reconnect.current = connect;
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
        const list = result.profiles ?? []; setProfiles(list); setProfilesLoaded(true);
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
    const listener = (message: Data) => {
      if (message.kind === "conn-status" && message.status?.state === "connected") { setError(current => bridgeUnavailable(current) ? "" : current); void load(); }
      if (message.kind === "profiles-changed" && message.runtime) {
        // Options stopped or started this profile's server; the profile list itself is unchanged.
        if (message.profileId !== currentProfile.current || !client.current) return;
        if (message.runtime === "stopped") {
          // The user stopped it on purpose: show that and wait, instead of starting it again.
          stream.current?.abort(); clearTimeout(offlineTimer.current); offlineTimer.current = undefined; streamOnline.current = false;
          setConnected(false); setError(SERVER_STOPPED);
        } else if (!streamOnline.current) void connect(currentProfile.current, client.current.directory, selected.current || undefined);
        return;
      }
      if (message.kind === "profiles-changed") void load(message.profileId);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => { active = false; epoch.current++; stream.current?.abort(); clearTimeout(refreshTimer.current); clearTimeout(listTimer.current); clearTimeout(offlineTimer.current); chrome.runtime.onMessage.removeListener(listener); };
  }, [connect]);
  // Which panel session owns a browser operation: its session ID, "other" for a different runtime, or undefined if unproven.
  const operationOwner = useCallback((operationId: string): string | undefined => {
    const binding = bindings.current.get(operationId); if (!binding) return undefined;
    return binding.client === client.current ? binding.sessionID : "other";
  }, []);
  const abortKnown = useCallback(async (operationId: string) => {
    const binding = bindings.current.get(operationId); if (!binding) return false;
    await binding.client.post(`/session/${encodeURIComponent(binding.sessionID)}/abort`); return true;
  }, []);
  return { state, dispatch, profiles, profilesLoaded, profileId, runtime, directory, sessions, sessionId, session: knownSessions[sessionId], knownSessions, sessionsLoading, hasMoreSessions, loadMoreSessions, loadChildren, childIndex, ensureChildren, updateSession, removeSession, connectionRevision: epoch.current, catalog, agents, commands, skills, todos, children, diff, mcp, connected, loading, error, setError, client, captureScope, watchResponse, connect, selectSession, resync, refreshSessions, abortKnown, operationOwner };
}
