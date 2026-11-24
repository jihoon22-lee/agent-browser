import { useEffect, useState } from "react";
import { concurrentRequestsOn } from "../background/concurrency";

/** On by default: another conversation can start a browser request while one is running. */
export function ConcurrentSetting() {
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void chrome.storage.local.get("concurrentRequests").then(stored => { if (live) setEnabled(concurrentRequestsOn(stored)); }).catch(() => {});
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes.concurrentRequests && live) setEnabled(concurrentRequestsOn({ concurrentRequests: changes.concurrentRequests.newValue }));
    };
    chrome.storage.onChanged?.addListener(onStorage);
    return () => { live = false; chrome.storage.onChanged?.removeListener(onStorage); };
  }, []);
  async function toggle() {
    if (busy) return;
    setBusy(true); setError("");
    const next = !enabled;
    try {
      await chrome.storage.local.set({ concurrentRequests: next });
      setEnabled(next);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <section><h2>동시 작업</h2>
    <p>켜면 한 대화가 브라우저 작업을 하는 동안 다른 대화에서도 지시를 보낼 수 있습니다. 동시에 4개까지 진행하고, 작업마다 서로 다른 탭을 씁니다. 한 대화 안에서는 지금처럼 한 번에 하나씩 진행합니다.</p>
    <label className="check"><input type="checkbox" disabled={busy} checked={enabled} onChange={() => void toggle()} /> 여러 대화의 브라우저 작업을 동시에 진행</label>
    {error && <p role="alert" className="error">{error}</p>}
    {!enabled && <p role="status">꺼져 있으면 진행 중인 요청이 끝나야 다음 요청을 보낼 수 있습니다.</p>}
  </section>;
}
