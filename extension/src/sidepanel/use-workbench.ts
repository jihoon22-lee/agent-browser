import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { OpenCodeV1Client } from "../agents/opencode-v1/client";
import { initialWorkbench, workbenchReducer, bridgeRequest, operationBindings, type Data, type UiMessage } from "./workbench-state";

export function useWorkbench() {
  const [state, dispatch] = useReducer(workbenchReducer, initialWorkbench);
  const [profiles, setProfiles] = useState<Data[]>([]), [profileId, setProfileId] = useState("");
  const [runtime, setRuntime] = useState<Data>(), [directory, setDirectory] = useState("");
  const [sessions, setSessions] = useState<Data[]>([]), [sessionId, setSessionId] = useState("");
  const [catalog, setCatalog] = useState<Data>({ all: [], connected: [], default: {} });
  const [agents, setAgents] = useState<Data[]>([]), [commands, setCommands] = useState<Data[]>([]), [skills, setSkills] = useState<Data[]>([]);
  const [todos, setTodos] = useState<Data[]>([]), [children, setChildren] = useState<Data[]>([]), [diff, setDiff] = useState<Data[]>([]), [mcp, setMcp] = useState<Data>({});
  const [connected, setConnected] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const client = useRef<OpenCodeV1Client | undefined>(undefined), epoch = useRef(0), stream = useRef<AbortController | undefined>(undefined), selected = useRef("");
  const syncing = useRef(false), buffered = useRef<Data[]>([]), refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bindings = useRef(new Map<string, { client: OpenCodeV1Client; sessionID: string; profileId: string; directory: string }>());
  const recentSessions = useRef(new Map<string, string>());
  const currentProfile = useRef(""), selectionRevision = useRef(0);
  const captureScope = useCallback(() => { const revision = epoch.current, selection = selectionRevision.current; return () => revision === epoch.current && selection === selectionRevision.current; }, []);
  const fail = (value: unknown) => setError(value instanceof Error ? value.message : String(value));
  const refreshSessions = useCallback(async (search?: string) => {
    const api = client.current, revision = epoch.current; if (!api) return;
    const next = await api.get<Data[]>("/session", { limit: 100, ...(search ? { search } : {}) });
    if (revision === epoch.current) setSessions(next);
  }, []);
  const remember = (messages: UiMessage[], api: OpenCodeV1Client) => { for (const [operationID, sessionID] of Object.entries(operationBindings(messages))) bindings.current.set(operationID, { client: api, sessionID, profileId: currentProfile.current, directory: api.directory }); };
  const resync = useCallback(async () => {
    const api = client.current, revision = epoch.current, id = selected.current;
    if (!api || syncing.current) return;
    syncing.current = true; buffered.current = [];
    try {
      const requests = [api.get<Data[]>("/question"), api.get<Data[]>("/permission"), api.get<Data>("/session/status"), api.get<Data[]>("/session", { limit: 100 })];
      const [questions, permissions, statuses, sessionList] = await Promise.all(requests);
      if (revision !== epoch.current) return;
      dispatch({ type: "pending", questions, permissions }); dispatch({ type: "statuses", statuses }); setSessions(Array.isArray(sessionList) ? sessionList : []);
      if (id) {
        const [messages, taskList, childList, differences] = await Promise.all([api.get<UiMessage[]>(`/session/${encodeURIComponent(id)}/message`), api.get<Data[]>(`/session/${encodeURIComponent(id)}/todo`), api.get<Data[]>(`/session/${encodeURIComponent(id)}/children`), api.get<Data[]>(`/session/${encodeURIComponent(id)}/diff`)]);
        if (revision !== epoch.current || id !== selected.current) return;
        dispatch({ type: "messages", sessionID: id, messages }); remember(messages, api); setTodos(taskList); setChildren(childList); setDiff(differences);
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
  }, []);
  const connect = useCallback(async (id: string, workdir?: string, restoreId?: string) => {
    const restored = restoreId ?? (id !== currentProfile.current ? recentSessions.current.get(id) : undefined) ?? "";
    if (currentProfile.current && selected.current) recentSessions.current.set(currentProfile.current, selected.current);
    const revision = ++epoch.current; stream.current?.abort(); clearTimeout(refreshTimer.current); syncing.current = false; buffered.current = [];
    setLoading(true); setConnected(false); setError(""); setProfileId(id); currentProfile.current = id;
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
        const part = (event.properties as Data).part;
        if (part?.type === "tool") remember([{ info: { sessionID: part.sessionID }, parts: [part] }], api);
        if (/^(session\.(created|updated|deleted)|todo\.updated)/.test(event.type)) { clearTimeout(refreshTimer.current); refreshTimer.current = setTimeout(() => void resync(), 120); }
      }, online => { if (revision === epoch.current) { setConnected(online); if (online) void resync(); } }, controller.signal).catch(value => { if (revision === epoch.current && !controller.signal.aborted) fail(value); });
      const results = await Promise.allSettled([api.get<Data>("/provider"), api.get<Data[]>("/agent"), api.get<Data[]>("/command"), api.get<Data[]>("/skill"), api.get<Data>("/mcp")]);
      if (revision !== epoch.current) return;
      const setters = [setCatalog, setAgents, setCommands, setSkills, setMcp] as Array<(value: any) => void>;
      results.forEach((result, index) => { if (result.status === "fulfilled") setters[index]!(result.value); else fail(result.reason); });
      await chrome.storage.local.set({ lastProfileId: id });
      await resync();
    } catch (value) { if (revision === epoch.current) fail(value); }
    finally { if (revision === epoch.current) setLoading(false); }
  }, [resync]);
  const selectSession = useCallback(async (session: Data) => {
    selectionRevision.current++;
    if (session.directory && session.directory !== client.current?.directory) { await connect(currentProfile.current, session.directory, session.id); return; }
    selected.current = session.id; setSessionId(session.id); setTodos([]); setChildren([]); setDiff([]); setError("");
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
    return () => { active = false; epoch.current++; stream.current?.abort(); clearTimeout(refreshTimer.current); chrome.runtime.onMessage.removeListener(listener); };
  }, [connect]);
  const abortKnown = useCallback(async (operationId: string) => {
    const binding = bindings.current.get(operationId); if (!binding) return false;
    await binding.client.post(`/session/${encodeURIComponent(binding.sessionID)}/abort`); return true;
  }, []);
  return { state, dispatch, profiles, profileId, runtime, directory, sessions, sessionId, catalog, agents, commands, skills, todos, children, diff, mcp, connected, loading, error, setError, client, captureScope, connect, selectSession, resync, refreshSessions, abortKnown };
}
