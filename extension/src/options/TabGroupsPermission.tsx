import { useEffect, useState } from "react";

/** Optional tabGroups: requested only from this click, never by an agent tool. */
export function TabGroupsPermission() {
  const [granted, setGranted] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => {
    if (!chrome.permissions) return;
    let live = true;
    const refresh = () => { void chrome.permissions.contains({ permissions: ["tabGroups"] }).then(value => { if (live) setGranted(value); }).catch(() => {}); };
    refresh(); chrome.permissions.onAdded.addListener(refresh); chrome.permissions.onRemoved.addListener(refresh);
    return () => { live = false; chrome.permissions.onAdded.removeListener(refresh); chrome.permissions.onRemoved.removeListener(refresh); };
  }, []);
  function toggle() {
    if (busy || !chrome.permissions) return;
    setBusy(true); setMessage("");
    const action = granted ? chrome.permissions.remove({ permissions: ["tabGroups"] }) : chrome.permissions.request({ permissions: ["tabGroups"] });
    void action.then(async () => { const allowed = await chrome.permissions.contains({ permissions: ["tabGroups"] }); setGranted(allowed); setMessage(allowed ? "작업 탭을 묶습니다." : "작업 탭 묶음을 사용하지 않습니다."); })
      .catch(error => setMessage(String(error))).finally(() => setBusy(false));
  }
  return <section><h2>작업 탭 묶음</h2><p>허용하면 에이전트가 작업 중인 탭을 "AgentBrowser" 탭 그룹으로 묶고, 작업이 끝나면 직접 묶은 탭만 풉니다. 이미 다른 그룹에 둔 탭은 옮기지 않습니다.</p>
    <button disabled={busy} onClick={toggle}>{granted ? "작업 탭 묶음 해제" : "작업 탭 묶음 허용"}</button><p role="status">{message || (granted ? "허용됨" : "허용 안 됨")}</p></section>;
}
