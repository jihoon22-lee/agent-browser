import {useEffect,useState} from 'react';
import {advancedAvailable} from '../agents/opencode-v1/capabilities';
type Item={id:number;filename:string;state:string;bound:boolean;complete:boolean};
export type AdvancedNotice={recovery:boolean;dialog?:{message:string;type:string}};
export function useAdvancedNotice(operationId:string|undefined,active:boolean):AdvancedNotice {
 const [notice,setNotice]=useState<AdvancedNotice>({recovery:false});
 useEffect(()=>{
  setNotice({recovery:false});
  if(!operationId||!active)return;
  let live=true;
  const poll=()=>void chrome.runtime.sendMessage({kind:'advanced-status',operationId}).then(r=>{
   if(!live||!r?.ok)return;
   const nextRecovery=r.result.inputRecoveryRequired===true;
   const nextDialog=r.result.dialog as {message:string;type:string}|undefined;
   setNotice(prev=>prev.recovery===nextRecovery&&prev.dialog?.type===nextDialog?.type&&prev.dialog?.message===nextDialog?.message?prev:{recovery:nextRecovery,dialog:nextDialog});
  }).catch(()=>{});
  poll();
  const timer=setInterval(poll,1500);
  return()=>{live=false;clearInterval(timer);};
 },[operationId,active]);
 return notice;
}
export function BrowserExtras({operationId,visible,notice}:{operationId:string;visible:boolean;notice?:AdvancedNotice}) {
 const [enabled,setEnabled]=useState(false),[items,setItems]=useState<Item[]>([]),[message,setMessage]=useState('');
 useEffect(()=>{const refresh=()=>void chrome.storage.local.get('advancedBrowser').then(d=>setEnabled(d.advancedBrowser===true&&advancedAvailable()));const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{if(area==='local'&&changes.advancedBrowser)refresh();};refresh();chrome.storage.onChanged?.addListener(changed);return()=>chrome.storage.onChanged?.removeListener(changed);},[]);
 const polled=useAdvancedNotice(operationId,visible&&!notice);
 const {recovery,dialog}=notice??polled;
 useEffect(()=>{setItems([]);setMessage('');},[operationId,visible]);
 async function refresh(id?:number){try {if(id!==undefined){const r=await chrome.runtime.sendMessage({kind:'download-bind',operationId,downloadId:id});if(!r?.ok)throw Error(r?.error?.message??'선택 실패');}
   const r=await chrome.runtime.sendMessage({kind:'downloads-list',operationId});if(!r?.ok)throw Error(r?.error?.message??'조회 실패');setItems(r.result.downloads);setMessage('');
 }catch(e){setMessage(String(e));}}
 if(!enabled&&!recovery&&!dialog)return null;
 return <section aria-label="브라우저 입력 상태"><h2>브라우저 입력 상태</h2>{recovery&&<p role="alert">입력이 중간에 멈춰 이 페이지의 자동 조작을 중지했습니다. 페이지를 직접 확인하고 필요한 내용을 저장한 뒤 새로고침해 주세요. 같은 동작을 다시 실행하지 마세요.</p>}{dialog&&<p role="status">웹페이지 {dialog.type}: {dialog.message} · 에이전트가 응답하거나 Chrome에서 직접 처리할 수 있습니다.</p>}
 {enabled&&<><h3>다운로드 확인</h3><p>현재 작업 중 생성된 후보입니다. 작업으로 내려받은 파일을 선택하면 에이전트가 해당 파일의 완료를 확인할 수 있습니다.</p><button onClick={()=>void refresh()}>다운로드 목록 새로고침</button>
 {message&&<p role="status">{message}</p>}<ul>{items.map(d=><li key={d.id}><strong>{d.filename}</strong> · {d.state} {d.bound?'· 이 작업에 연결됨':<button onClick={()=>void refresh(d.id)}>이 파일 선택</button>}</li>)}</ul></>}</section>;
}
