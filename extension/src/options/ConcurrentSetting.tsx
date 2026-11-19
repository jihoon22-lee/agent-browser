import { useEffect, useState } from "react";
import { concurrentRequestsOn } from "../background/concurrency";

/** On by default: another conversation can start a browser request while one is running. */
export function ConcurrentSetting() {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => { void chrome.storage.local.get("concurrentRequests").then(stored => setEnabled(concurrentRequestsOn(stored))).catch(() => {}); }, []);
  async function toggle() {
    const next = !enabled;
    await chrome.storage.local.set({ concurrentRequests: next });
    setEnabled(next);
  }
  return <section><h2>동시 작업</h2>
    <p>켜면 한 대화가 브라우저 작업을 하는 동안 다른 대화에서도 지시를 보낼 수 있습니다. 동시에 4개까지 진행하고, 작업마다 서로 다른 탭을 씁니다. 한 대화 안에서는 지금처럼 한 번에 하나씩 진행합니다.</p>
    <label><input type="checkbox" checked={enabled} onChange={() => void toggle()} /> 여러 대화의 브라우저 작업을 동시에 진행</label>
    {!enabled && <p role="status">꺼져 있으면 진행 중인 요청이 끝나야 다음 요청을 보낼 수 있습니다.</p>}
  </section>;
}
