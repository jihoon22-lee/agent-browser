import {useEffect,useState} from 'react';
import {advancedAvailable} from '../agents/opencode-v1/capabilities';
export function AdvancedSetting(){
 const [enabled,setEnabled]=useState(false),[allowed,setAllowed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const supported=advancedAvailable();
 useEffect(()=>{
  let live=true;
  void chrome.storage.local.get('advancedBrowser').then(d=>{if(live)setEnabled(d.advancedBrowser===true);}).catch(()=>{});
  const onStorage=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area==='local'&&changes.advancedBrowser&&live)setEnabled(changes.advancedBrowser.newValue===true);};
  const refresh=()=>void chrome.permissions?.contains({permissions:['downloads']}).then(v=>{if(live)setAllowed(v);}).catch(()=>{});
  refresh();
  chrome.storage.onChanged?.addListener(onStorage);
  chrome.permissions?.onAdded.addListener(refresh);
  chrome.permissions?.onRemoved.addListener(refresh);
  return()=>{live=false;chrome.storage.onChanged?.removeListener(onStorage);chrome.permissions?.onAdded.removeListener(refresh);chrome.permissions?.onRemoved.removeListener(refresh);};
 },[]);
 return <section><h2>고급 브라우저 기능</h2><p>Chrome 125 이상에서 텍스트·프레임 입력 강화, 화면 좌표 조작, 대화상자 응답, 전체·영역 캡처와 다운로드 확인을 사용합니다. 디버거 기능은 신뢰 입력도 켜야 합니다. 화면 좌표 조작은 현재 요청 모델의 이미지 입력·도구 호출 지원이 필요합니다.</p>
 {!supported&&<p>현재 브라우저에서는 기존 기능만 사용할 수 있습니다. 고급 기능은 Chrome 125 이상이 필요합니다.</p>}
 <label className="check"><input type="checkbox" disabled={!supported||busy} checked={enabled&&supported} onChange={e=>{if(busy)return;const on=e.target.checked;setBusy(true);setError('');void chrome.storage.local.set({advancedBrowser:on}).then(()=>setEnabled(on)).catch(err=>setError(String(err))).finally(()=>setBusy(false));}}/>고급 기능 사용</label>
 <p>다운로드 접근은 선택 권한입니다. 현재 작업 중 생성된 후보의 이름과 상태를 확인하며, 다른 다운로드와 혼동하지 않도록 브라우저 패널에서 파일을 선택합니다. 파일 내용은 읽지 않습니다.</p>
 <button type="button" disabled={!supported||busy} onClick={()=>{if(busy)return;if(!chrome.permissions){setError('이 브라우저에서는 선택 권한 API를 사용할 수 없습니다.');return;}setBusy(true);setError('');const task=allowed?chrome.permissions.remove({permissions:['downloads']}):chrome.permissions.request({permissions:['downloads']});void task.then(()=>chrome.permissions.contains({permissions:['downloads']})).then(setAllowed).catch(err=>setError(String(err))).finally(()=>setBusy(false));}}>{allowed?'다운로드 접근 해제':'다운로드 접근 허용'}</button>
 <p role="status">{error||(allowed?'다운로드 접근 허용됨':'다운로드 접근 허용 안 됨')}</p></section>;
}
