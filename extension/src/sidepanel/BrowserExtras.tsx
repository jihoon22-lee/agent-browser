import {useEffect,useState} from 'react';
import {advancedAvailable} from '../agents/opencode-v1/capabilities';
type Item={id:number;filename:string;state:string;bound:boolean;complete:boolean};
export function BrowserExtras({operationId,visible}:{operationId:string;visible:boolean}) {
 const [enabled,setEnabled]=useState(false),[items,setItems]=useState<Item[]>([]),[message,setMessage]=useState(''),[dialog,setDialog]=useState<{message:string;type:string}>();
 useEffect(()=>{const refresh=()=>void chrome.storage.local.get('advancedBrowser').then(d=>setEnabled(d.advancedBrowser===true&&advancedAvailable()));refresh();chrome.storage.onChanged?.addListener(refresh);return()=>chrome.storage.onChanged?.removeListener(refresh);},[]);
 useEffect(()=>{setItems([]);setMessage('');setDialog(undefined);if(!visible||!enabled)return;let live=true;const refresh=()=>void chrome.runtime.sendMessage({kind:'advanced-status',operationId}).then(r=>{if(live&&r?.ok)setDialog(r.result.dialog);}).catch(()=>{});refresh();const timer=setInterval(refresh,1500);return()=>{live=false;clearInterval(timer);};},[operationId,visible,enabled]);
 async function refresh(id?:number){try {if(id!==undefined){const r=await chrome.runtime.sendMessage({kind:'download-bind',operationId,downloadId:id});if(!r?.ok)throw Error(r?.error?.message??'선택 실패');}
   const r=await chrome.runtime.sendMessage({kind:'downloads-list',operationId});if(!r?.ok)throw Error(r?.error?.message??'조회 실패');setItems(r.result.downloads);setMessage('');
 }catch(e){setMessage(String(e));}}
 if(!enabled)return null;
 return <section aria-label="고급 작업 상태"><h2>고급 작업 상태</h2>{dialog&&<p role="status">웹페이지 {dialog.type}: {dialog.message} · 에이전트가 응답하거나 Chrome에서 직접 처리할 수 있습니다.</p>}
 <h3>다운로드 확인</h3><p>현재 작업 중 생성된 후보입니다. 작업으로 내려받은 파일을 선택하면 에이전트가 해당 파일의 완료를 확인할 수 있습니다.</p><button onClick={()=>void refresh()}>다운로드 목록 새로고침</button>
 {message&&<p role="status">{message}</p>}<ul>{items.map(d=><li key={d.id}><strong>{d.filename}</strong> · {d.state} {d.bound?'· 이 작업에 연결됨':<button onClick={()=>void refresh(d.id)}>이 파일 선택</button>}</li>)}</ul></section>;
}
