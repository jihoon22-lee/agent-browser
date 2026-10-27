import { ProtocolError } from '../protocol/errors';
/** Resolve frame ownership by WindowProxy identity, not URL/index (identical URLs are common).
 * Both scripts are pinned to Chrome documentIds. The nonce only identifies this geometry probe. */
export async function frameInputTarget(tabId:number,documentId:string,point:{x:number;y:number}|undefined,active:()=>boolean) {
  const stale=()=>new ProtocolError('STALE_ELEMENT','The input frame or its focused target changed. Observe again.');
  const original=await chrome.webNavigation.getAllFrames({tabId}) ?? [];
  let child=original.find(f=>f.documentId===documentId);
  if(!child)throw stale();
  let current=point;
  while(child.parentFrameId!==-1) {
    if(!active())throw stale();
    const parent=original.find(f=>f.frameId===child!.parentFrameId);
    if(!parent)throw stale();
    const nonce=crypto.randomUUID();
    // Register the listener before posting from the child. executeScript completion awaits the probe.
    const listening=chrome.scripting.executeScript({target:{tabId,documentIds:[parent.documentId]},args:[nonce,current??null],func:async(nonce:string,point:{x:number;y:number}|null)=>{
      return await new Promise<{x:number;y:number}|true|null>(resolve=>{
        const timer=setTimeout(()=>finish(null),1500);
        const finish=(value:{x:number;y:number}|true|null)=>{clearTimeout(timer);window.removeEventListener('message',listener);resolve(value);};
        const frames=(root:Document|ShadowRoot):HTMLIFrameElement[]=>[...root.querySelectorAll('iframe,frame')] as HTMLIFrameElement[];
        const all=(root:Document|ShadowRoot):HTMLIFrameElement[]=>[...frames(root),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?all(e.shadowRoot):[])];
        const listener=(event:MessageEvent)=>{
          if(event.data?.agentBrowserGeometry!==nonce)return;
          const frame=all(document).find(frame=>frame.contentWindow===event.source);if(!frame)return;
          if(!point) {let focused:Element|null=document.activeElement;while(focused?.shadowRoot?.activeElement)focused=focused.shadowRoot.activeElement;finish(focused===frame?true:null);return;}
          // Rectangles preserve translation/axis-aligned scaling only. Reject transforms we cannot verify.
          for(let node:Element|null=frame;node;node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null){
            const s=getComputedStyle(node);if(s.perspective!=='none'){finish(null);return;}
            if(s.transform!=='none'){const m=new DOMMatrixReadOnly(s.transform);if(!m.is2D||m.b!==0||m.c!==0||m.a<=0||m.d<=0){finish(null);return;}}
          }
          const r=frame.getBoundingClientRect(),sx=r.width/frame.offsetWidth,sy=r.height/frame.offsetHeight;
          const p={x:r.left+(frame.clientLeft+parseFloat(getComputedStyle(frame).paddingLeft||'0')+point.x)*sx,y:r.top+(frame.clientTop+parseFloat(getComputedStyle(frame).paddingTop||'0')+point.y)*sy};
          let hit:Element|null=document.elementFromPoint(p.x,p.y);while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(p.x,p.y);if(!next||next===hit)break;hit=next;}
          finish(Number.isFinite(p.x)&&Number.isFinite(p.y)&&hit===frame?p:null);
        };
        window.addEventListener('message',listener);
        // The child can post only after the background observes this ready marker.
        (globalThis as any)[nonce]=true;
      }).finally(()=>{delete (globalThis as any)[nonce];});
    }}).catch(()=>[]);
    // Await listener readiness without allowing a page script to nominate a different frame.
    let ready=false;
    for(let i=0;i<30&&!ready;i++) {
      const [r]=await chrome.scripting.executeScript({target:{tabId,documentIds:[parent.documentId]},args:[nonce],func:(key:string)=>(globalThis as any)[key]===true});
      ready=r?.result===true;if(!ready)await new Promise(r=>setTimeout(r,10));
    }
    if(ready&&active()) await chrome.scripting.executeScript({target:{tabId,documentIds:[child.documentId]},args:[nonce],func:(nonce:string)=>{window.parent.postMessage({agentBrowserGeometry:nonce},'*');}});
    const [result]=await listening;
    if(!active()||!result?.result)throw stale();
    if(current)current=result.result as {x:number;y:number};
    child=parent;
  }
  const live=await chrome.webNavigation.getAllFrames({tabId}) ?? [];
  for(const f of original)if(!live.some(n=>n.frameId===f.frameId&&n.documentId===f.documentId))throw stale();
  if(!active())throw stale();
  return current;
}
