import { useEffect, useState } from "react";

/** Off by default: only when on does AgentBrowser attach Chrome's debugger to this browser's operation tabs. */
export function TrustedInputSetting() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { void chrome.storage.local.get("trustedInput").then(({ trustedInput }) => setEnabled(trustedInput === true)).catch(() => {}); }, []);
  async function toggle() {
    const next = !enabled;
    await chrome.storage.local.set({ trustedInput: next });
    setEnabled(next);
  }
  return <section><h2>신뢰 입력</h2>
    <p>일부 사이트는 일반 확장 입력을 무시합니다. 켜면 에이전트의 클릭·키 입력을 Chrome 디버거로 보내 실제 사용자 입력처럼 처리하고, 작업 중 뜬 알림창(alert)은 확인, 확인창(confirm)은 취소한 뒤 결과로 알립니다. 비활성 작업 탭도 화면을 캡처할 수 있습니다.</p>
    <label><input type="checkbox" checked={enabled} onChange={() => void toggle()} /> 신뢰 입력 사용(디버거)</label>
    {enabled && <p role="status">작업 중인 탭 위에 "AgentBrowser가 이 브라우저를 디버깅하는 중" 표시줄이 나타납니다. 표시줄의 [취소]를 누르면 그 작업은 일반 입력으로 계속합니다. 작업이 끝나면 디버거는 바로 분리됩니다.</p>}
  </section>;
}
