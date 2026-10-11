import { useEffect, useState } from "react";
import { DEFAULT_BRIDGE_URL, type ConnStatus } from "../background/bridge-connection";

const LABELS: Record<ConnStatus["state"], string> = {
  unpaired: "토큰이 없습니다. 아래에 페어링 토큰을 입력하세요.",
  connecting: "연결하는 중…",
  connected: "Bridge에 연결되었습니다.",
  auth_failed: "토큰이 맞지 않습니다. 토큰을 다시 입력하세요.",
  not_paired: "이 Bridge는 다른 확장 ID와 페어링되어 있습니다. 토큰을 다시 입력해 다시 페어링하세요.",
  disconnected: "Bridge에 연결할 수 없습니다. 다시 시도하는 중…",
};

export function App() {
  const [url, setUrl] = useState(DEFAULT_BRIDGE_URL);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ConnStatus>({ state: "disconnected" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get("bridgeUrl").then((v) => { if (typeof v.bridgeUrl === "string") setUrl(v.bridgeUrl); });
    void chrome.runtime.sendMessage({ kind: "get-conn-status" }).then((s: ConnStatus | undefined) => { if (s) setStatus(s); }).catch(() => {});
    const listener = (msg: { kind?: string; status?: ConnStatus }) => {
      if (msg.kind === "conn-status" && msg.status) setStatus(msg.status);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  async function save() {
    const next: Record<string, unknown> = { bridgeUrl: url };
    if (token.trim()) {
      next.pairingToken = token.trim();
      next.repairPending = true;
    }
    await chrome.storage.local.set(next);
    setToken("");
    setSaved(true);
  }

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 560, margin: "2rem auto", lineHeight: 1.5 }}>
      <h1>AgentBrowser 설정</h1>
      <p>Windows 터미널에서 <code>browser-bridge.exe pair</code>를 실행해 나온 토큰을 붙여 넣으세요.</p>
      <label>Bridge 주소<br />
        <input style={{ width: "100%" }} value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <p />
      <label>페어링 토큰<br />
        <input style={{ width: "100%" }} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <p><button onClick={() => void save()}>저장 후 연결</button> {saved && <span>저장했습니다.</span>}</p>
      <p role="status">{LABELS[status.state]}{status.detail ? ` (${status.detail})` : ""}</p>
    </main>
  );
}
