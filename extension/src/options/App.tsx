import { useEffect, useState } from "react";
import { DEFAULT_BRIDGE_URL, type ConnStatus } from "../background/bridge-connection";
import { bridgeRequest, type Data } from "../sidepanel/workbench-state";
import { validatePairing, profilePayload, type ProfileForm, passwordDropped, formFromProfile } from "./profile-form";
import "./style.css";
import { BookmarksPermission } from "./BookmarksPermission";
import { THEMES, themeNames, useTheme } from "../theme/themes";
const LABELS: Record<ConnStatus["state"], string> = { unpaired: "페어링 토큰을 입력하세요.", connecting: "연결하는 중…", connected: "Bridge에 연결되었습니다.", auth_failed: "상호 인증에 실패했습니다. 주소·버전·토큰을 확인하세요.", not_paired: "다른 확장과 페어링되어 있습니다. 토큰으로 다시 페어링하세요.", disconnected: "Bridge 연결을 다시 시도하는 중…" };
const blank: ProfileForm = { id: "", name: "", kind: "windows", directory: "", executable: "", distribution: "", user: "", baseUrl: "http://127.0.0.1:4096", username: "opencode", password: "", port: "", envText: "" };
export function App() {
  const { theme, chooseTheme } = useTheme();
  const [url, setUrl] = useState(DEFAULT_BRIDGE_URL), [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnStatus>({ state: "disconnected" });
  const [pairCode, setPairCode] = useState("");
  const [profiles, setProfiles] = useState<Data[]>([]), [defaultId, setDefaultId] = useState("");
  const [form, setForm] = useState<ProfileForm>(blank), [editing, setEditing] = useState(false), [makeDefault, setMakeDefault] = useState(true);
  const [notice, setNotice] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [doctor, setDoctor] = useState<Data>();
  const refresh = async () => { const data = await bridgeRequest("profile.list"); setProfiles(data.profiles ?? []); setDefaultId(data.defaultProfileId ?? ""); };
  useEffect(() => {
    let active = true;
    void chrome.storage.local.get("bridgeUrl").then(value => { if (active && typeof value.bridgeUrl === "string") setUrl(value.bridgeUrl); }).catch(error => { if (active) setError(String(error)); });
    void chrome.runtime.sendMessage({ kind: "get-conn-status" }).then((value: ConnStatus | undefined) => { if (active && value) setStatus(value); }).catch(() => {});
    const listener = (message: { kind?: string; status?: ConnStatus }) => { if (message.kind === "conn-status" && message.status) setStatus(message.status); };
    chrome.runtime.onMessage.addListener(listener); return () => { active = false; chrome.runtime.onMessage.removeListener(listener); };
  }, []);
  useEffect(() => { if (status.state === "connected") void refresh().catch(error => setError(error.message)); }, [status.state]);
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); setNotice(""); try { await action(); } catch (error) { setError(error instanceof Error ? error.message : "요청에 실패했습니다."); } finally { setBusy(false); } }
  const field = (key: keyof ProfileForm, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const connected = status.state === "connected";
  return <main className="options"><header className="options-header"><div><h1>AgentBrowser 설정</h1><p>Chrome과 기존 OpenCode 실행 환경을 연결합니다.</p></div><label>테마<select aria-label="테마" value={theme} onChange={event => chooseTheme(event.target.value)}>{(["system", ...THEMES] as const).map(name => <option key={name} value={name}>{themeNames[name]}</option>)}</select></label></header>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <section><h2>Bridge 페어링</h2><p>설치 마법사의 [Chrome에 연결]에 표시된 6자리 코드를 입력하세요. 코드가 없으면 아래에 설치 폴더의 페어링 토큰을 직접 입력할 수 있습니다.</p>
      <label>페어링 코드<input value={pairCode} onChange={event => setPairCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="6자리 숫자" /></label>
      <button disabled={busy || pairCode.length !== 6} onClick={() => void run(async () => { const response = await chrome.runtime.sendMessage({ kind: "pair-with-code", code: pairCode }); if (!response?.ok) throw new Error(response?.error?.message ?? "페어링하지 못했습니다."); setPairCode(""); setNotice("Bridge와 연결했습니다."); })}>코드로 연결</button>
      <label>Bridge 주소<input value={url} onChange={event => setUrl(event.target.value)} autoComplete="off" /></label>
      <label>페어링 토큰<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder="기존 토큰을 유지하려면 비워두세요" /></label>
      <button disabled={busy} onClick={() => void run(async () => { const next = validatePairing(url, token); await chrome.storage.local.set(next); setToken(""); await chrome.runtime.sendMessage({ kind: "reconnect" }); setNotice("저장했습니다. 연결 상태를 확인하세요."); })}>저장 후 연결</button>
      <p role="status">{LABELS[status.state]}</p>
    </section>
    <section><div className="row"><h2>OpenCode 실행 환경</h2><button disabled={busy || !connected} onClick={() => { setForm(blank); setEditing(false); }}>프로필 추가</button></div>
      {!connected && <p>Bridge에 먼저 연결하세요.</p>}
      <ul className="profiles">{profiles.map(profile => <li key={profile.id}><div><strong>{profile.name}</strong> <span>{profile.kind}{profile.id === defaultId ? " · 기본" : ""}</span><small>{profile.directory}</small></div><div className="row">
        <button disabled={busy} onClick={() => { setForm(formFromProfile(blank, profile as unknown as Record<string, unknown>)); setEditing(true); setMakeDefault(profile.id === defaultId); }}>편집</button>
        <button disabled={busy} onClick={() => void run(async () => { const info = await bridgeRequest("runtime.ensure", { profileId: profile.id }); if (info.state !== "ready") throw new Error(info.error ?? "실행 환경을 준비하지 못했습니다."); setNotice(`${profile.name}: 준비됨 · OpenCode ${info.version ?? "버전 정보 없음"}`); })}>시작·연결 확인</button>
        <button disabled={busy} onClick={() => void run(async () => { const info = await bridgeRequest("runtime.stop", { profileId: profile.id }); setNotice(info.stopped ? "Bridge가 시작한 서버를 종료했습니다." : "종료할 소유 서버가 없습니다. 기존 외부 서버는 유지됩니다."); })}>서버 중지</button>
        <button disabled={busy} onClick={() => { if (window.confirm(`프로필 '${profile.name}'을 삭제할까요? 기존 OpenCode 설정·대화는 유지됩니다.`)) void run(async () => { await bridgeRequest("profile.delete", { profileId: profile.id }); await chrome.runtime.sendMessage({ kind: "profiles-changed", profileId: profile.id }).catch(() => {}); await refresh(); setNotice("프로필을 삭제했습니다."); }); }}>삭제</button>
      </div></li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); void run(async () => { const payload = profilePayload(form); const original = editing ? profiles.find(item => item.id === form.id) as { kind: string; baseUrl?: string; username?: string; hasPassword?: boolean } | undefined : undefined; await bridgeRequest("profile.save", { profile: payload, makeDefault }); await chrome.runtime.sendMessage({ kind: "profiles-changed", profileId: form.id }).catch(() => {}); setForm(blank); setEditing(false); await refresh(); setNotice(passwordDropped(original, payload) ? "서버 주소나 인증 사용자가 바뀌어 이전 비밀번호는 지웠습니다. 인증이 필요한 서버라면 새 비밀번호를 입력해 다시 저장하세요." : "실행 프로필을 저장했습니다."); }); }}>
        <h3>{editing ? "프로필 편집" : "새 프로필"}</h3><div className="grid"><label>ID<input value={form.id} disabled={editing} onChange={e => field("id", e.target.value)} placeholder="work-wsl" /></label><label>이름<input value={form.name} onChange={e => field("name", e.target.value)} placeholder="업무 환경" /></label></div>
        <label>실행 방식<select value={form.kind} onChange={e => field("kind", e.target.value)}><option value="windows">Windows 네이티브</option><option value="wsl">WSL</option><option value="external">이미 실행 중인 서버</option></select></label>
        {form.kind !== "external" ? <label>OpenCode 실행 파일의 절대 경로<input value={form.executable} onChange={e => field("executable", e.target.value)} placeholder={form.kind === "wsl" ? "/home/user/.opencode/bin/opencode" : "C:\\Tools\\opencode.exe"} /></label> : <label>서버 주소<input value={form.baseUrl} onChange={e => field("baseUrl", e.target.value)} /></label>}
        {form.kind === "wsl" && <div className="grid"><label>WSL 배포판<input value={form.distribution} onChange={e => field("distribution", e.target.value)} placeholder="Ubuntu" /></label><label>WSL 사용자(선택)<input value={form.user} onChange={e => field("user", e.target.value)} /></label></div>}
        <label>작업 디렉터리<input value={form.directory} onChange={e => field("directory", e.target.value)} placeholder={form.kind === "wsl" ? "/home/user/project" : "C:\\Work\\project"} /></label>
        <details><summary>인증·환경변수·포트</summary><p>비밀번호와 환경변수 값은 목록에 표시하지 않습니다. 편집 시 비워두면 저장된 값을 유지합니다.</p>
          <div className="grid"><label>인증 사용자<input value={form.username} onChange={e => field("username", e.target.value)} autoComplete="off" /></label><label>새 비밀번호<input type="password" value={form.password} onChange={e => field("password", e.target.value)} autoComplete="new-password" /></label></div>
          <label>포트(선택)<input inputMode="numeric" value={form.port} onChange={e => field("port", e.target.value)} placeholder="비워두면 자동 선택" /></label>
          <label>추가 환경변수(JSON)<textarea value={form.envText} onChange={e => field("envText", e.target.value)} placeholder={'{"NAME":"value"}'} autoComplete="off" spellCheck={false} /></label>
        </details><label className="check"><input type="checkbox" checked={makeDefault} onChange={e => setMakeDefault(e.target.checked)} />기본 실행 환경으로 사용</label><button disabled={busy || !connected}>프로필 저장</button>
      </form>
    </section>
    <BookmarksPermission />
    <section><h2>연결 진단</h2><p>Extension·Bridge·실행 환경·OpenCode·MCP 상태를 확인합니다. 모델 요청은 보내지 않습니다.</p><button disabled={busy || !connected} onClick={() => void run(async () => { setDoctor(await bridgeRequest("doctor.run")); })}>진단 실행</button>{doctor && <pre className="diagnostic">{JSON.stringify(doctor, null, 2)}</pre>}</section>
  </main>;
}
