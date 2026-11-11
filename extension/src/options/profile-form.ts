export type ProfileForm = { id: string; name: string; kind: string; directory: string; executable?: string; distribution?: string; user?: string; baseUrl?: string; username?: string; password?: string; port?: string; envText?: string };
const BRIDGE_ADDRESS = "Bridge 주소는 ws://127.0.0.1:<포트>/extension 형식이어야 합니다. 예: ws://127.0.0.1:4317/extension";
const SERVER_ADDRESS = "서버 주소는 http:// 또는 https://로 시작하는 주소로 입력하세요. 예: http://127.0.0.1:4096";
const ENV_JSON = '환경변수는 문자열 값의 JSON 객체로 입력하세요. 예: {"NAME":"value"}';
// The browser's own parse errors are English ("Invalid URL", "Unexpected token"); say what to type instead.
function parsed<T>(read: () => T, message: string): T { try { return read(); } catch { throw new Error(message); } }
export function validatePairing(address: string, token: string): Record<string, unknown> {
  const url = parsed(() => new URL(address.trim()), BRIDGE_ADDRESS);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/extension" || url.username || url.password || url.search || url.hash) throw new Error(BRIDGE_ADDRESS);
  const result: Record<string, unknown> = { bridgeUrl: url.href };
  if (token.trim()) {
    if (!/^[a-f0-9]{64}$/.test(token.trim())) throw new Error("페어링 토큰은 출력된 64자리 소문자 16진수 값을 그대로 입력하세요.");
    result.pairingToken = token.trim(); result.repairPending = true;
  }
  return result;
}
export function profilePayload(form: ProfileForm): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(form.id)) throw new Error("프로필 ID는 영문·숫자·밑줄·하이픈 64자 이내로 입력하세요.");
  if (!form.name.trim() || !form.directory.trim()) throw new Error("이름과 작업 디렉터리를 입력하세요.");
  const profile: Record<string, unknown> = { id: form.id, name: form.name.trim(), kind: form.kind, directory: form.directory.trim() };
  if (form.kind !== "external" && !form.executable?.trim()) throw new Error("OpenCode 실행 파일의 절대 경로를 입력하세요.");
  if (form.kind === "external") { const url = parsed(() => new URL((form.baseUrl ?? "").trim()), SERVER_ADDRESS); if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("서버 주소에는 HTTP(S) 주소만 입력하고 인증정보는 별도 필드를 사용하세요."); profile.baseUrl = url.href; }
  for (const key of ["executable", "distribution", "user", "username", "password"] as const) if (form[key]?.trim()) profile[key] = key === "password" ? form[key] : form[key]!.trim();
  if (form.port?.trim()) { const port = Number(form.port); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("포트는 1–65535 범위입니다."); profile.port = port; }
  if (form.envText?.trim()) { const env = parsed(() => JSON.parse(form.envText!), ENV_JSON); if (!env || Array.isArray(env) || typeof env !== "object" || Object.values(env).some(value => typeof value !== "string")) throw new Error(ENV_JSON); profile.env = env; }
  return profile;
}

/** The Bridge keeps a saved password only for the same server and user (profile.rs preserve_secrets). */
export function passwordDropped(original: { kind: string; baseUrl?: string; username?: string; hasPassword?: boolean } | undefined, payload: Record<string, unknown>): boolean {
  if (!original?.hasPassword || original.kind !== "external") return false;
  // A profile that stops being an external server keeps no server password.
  if (payload.kind !== "external") return true;
  return typeof payload.password !== "string" && (original.baseUrl !== payload.baseUrl || (original.username ?? "") !== (payload.username ?? ""));
}

/** The edit form for a saved profile. A missing username stays empty: the new-profile default
 * would read as a changed user and make the Bridge drop the saved password. */
export function formFromProfile<T extends Record<string, unknown>>(blank: T, profile: Record<string, unknown>): T {
  return { ...blank, ...profile, username: typeof profile.username === "string" ? profile.username : "", password: "", envText: "",
    port: typeof profile.port === "number" ? String(profile.port) : "" } as T;
}

/** A new profile left without an ID is named after its kind; the ID only identifies the profile inside the Bridge. */
export function withProfileId(form: ProfileForm, suffix = crypto.randomUUID().slice(0, 8)): ProfileForm {
  return form.id.trim() ? form : { ...form, id: `${form.kind}-${suffix}` };
}
