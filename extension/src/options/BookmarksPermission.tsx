import {useEffect,useState} from 'react';
export function BookmarksPermission() {
  const [granted,setGranted]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>{
    if(!chrome.permissions)return;
    let live=true;
    const refresh=()=>{void chrome.permissions.contains({permissions:['bookmarks']}).then(value=>{if(live)setGranted(value);}).catch(()=>{});};
    refresh();chrome.permissions.onAdded.addListener(refresh);chrome.permissions.onRemoved.addListener(refresh);
    return()=>{live=false;chrome.permissions.onAdded.removeListener(refresh);chrome.permissions.onRemoved.removeListener(refresh);};
  },[]);
  function toggle() {
    if(busy || !chrome.permissions)return;
    setBusy(true);setMessage('');
    // request must run directly in this trusted user gesture, never via an agent tool.
    const action=granted ? chrome.permissions.remove({permissions:['bookmarks']}) : chrome.permissions.request({permissions:['bookmarks']});
    void action.then(async()=>{const allowed=await chrome.permissions.contains({permissions:['bookmarks']});setGranted(allowed);setMessage(allowed?'즐겨찾기 조회가 허용되었습니다.':'즐겨찾기 접근은 허용되지 않은 상태입니다.');})
      .catch(error=>setMessage(String(error))).finally(()=>setBusy(false));
  }
  return <section><h2>즐겨찾기 접근</h2><p>목록·검색·폴더 조회를 사용하려면 선택 권한을 허용하세요. Chrome의 즐겨찾기 권한은 읽기와 변경을 포함하지만 AgentBrowser 도구는 읽기만 제공합니다. 에이전트에 반환된 즐겨찾기 제목과 URL은 연결된 모델에 전달될 수 있습니다.</p>
    <button disabled={busy} onClick={toggle}>{granted?'즐겨찾기 접근 해제':'즐겨찾기 접근 허용'}</button><p role="status">{message || (granted?'허용됨':'허용 안 됨')}</p></section>;
}
