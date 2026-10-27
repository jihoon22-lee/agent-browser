import { advancedAvailable } from '../agents/opencode-v1/capabilities';
import { ProtocolError } from '../protocol/errors';
import type { Req } from '../protocol/envelope';
import type { ChromeApi } from './chrome-api';
import type { DebuggerApi, TrustedInput } from './trusted-input';
import { aborted, interruptible } from './tabs';
export type CaptureGeometry={operationId:string;generation:number;targetEpoch?:number;tabId:number;documentId:string;scrollX:number;scrollY:number;width:number;height:number;scale:number;dpr:number;created:number;region:{x:number;y:number;width:number;height:number};imageWidth:number;imageHeight:number};
const stale=()=>new ProtocolError('STALE_ELEMENT','The captured screen changed or expired. Take a new viewport screenshot before using coordinates.','safe');
export function capturePoint(c:CaptureGeometry,x:number,y:number) {
 if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=c.imageWidth||y>=c.imageHeight)throw new ProtocolError('INVALID_PARAMS','Coordinates must be inside the returned image.');
 return {x:c.region.x+x*c.region.width/c.imageWidth,y:c.region.y+y*c.region.height/c.imageHeight};
}
export function validateCapture(c:CaptureGeometry,now:Pick<CaptureGeometry,'operationId'|'generation'|'targetEpoch'|'tabId'|'documentId'|'scrollX'|'scrollY'|'width'|'height'|'scale'|'dpr'>,at=Date.now()) {
 for(const k of ['operationId','generation','targetEpoch','tabId','documentId','scrollX','scrollY','width','height','scale','dpr'] as const)if(c[k]!==now[k])throw new ProtocolError('STALE_ELEMENT','The captured screen changed. Take a new viewport screenshot.','safe',{changed:k,before:c[k],after:now[k]});
 if(at-c.created>30000)throw stale();
}
export const advancedMethod=(method:string,p:Record<string,unknown>,enabled:boolean)=>['browser.pointer','browser.dialog','browser.downloads'].includes(method)||(method==='browser.screenshot'&&(enabled||(p.scope!==undefined&&p.scope!=='viewport')||p.region!==undefined));
type Dialog={dialogId:string;type:string;message:string;requestId?:string;operationId:string;generation:number;tabId:number;owned:boolean;state:"open"|"responding"|"uncertain"};
type StoredCapture={geometry:CaptureGeometry;bitmap:ImageBitmap};
export function advancedBrowser(api:ChromeApi,debug:DebuggerApi,trusted:TrustedInput,enabled:()=>boolean,ensure:(tabId:number)=>Promise<boolean>,vision:(requestId:unknown,args:Record<string,unknown>)=>Promise<boolean>,current:()=>{id?:string;generation?:number;tabs?:number[]}|null=()=>null,inputStatus?:(tabId:number)=>Promise<{required:boolean;pending?:boolean}>) {
 const works=new Map<string,{tabId:number;method:string;promise:Promise<any>}>();
 const captures=new Map<string,StoredCapture>(),pending=new Map<number,Dialog>(),observers=new Map<number,{req:Req;notify:(dialog:Dialog)=>void}>();
 const forget=()=>{for(const c of captures.values())c.bitmap.close();captures.clear();};
 const gate=()=>{if(!advancedAvailable()||!enabled())throw new ProtocolError('FORBIDDEN_METHOD','Enable advanced browser features in Settings (Chrome 125 or later).');};
 const requireDebugger=async(tabId:number)=>{gate();if(!await ensure(tabId))throw new ProtocolError('FORBIDDEN_METHOD','Trusted input is disabled or Chrome debugger is unavailable.');};
 debug.onEvent((tabId,method,p)=>{
   if(method==='Page.javascriptDialogClosed'){pending.delete(tabId);return;}
   if(method!=='Page.javascriptDialogOpening'||!enabled()||!advancedAvailable()||!trusted.isAttached(tabId))return;
   const observer=observers.get(tabId),op=current();
   if(!observer&&!op?.tabs?.includes(tabId))return;
   const dialog:Dialog={dialogId:crypto.randomUUID(),type:String(p.type),message:String(p.message??'').slice(0,2000),requestId:observer?.req.id,operationId:String(observer?.req.params.operationId??op?.id),generation:Number(observer?.req.params.generation??op?.generation),tabId,owned:!!observer,state:'open'};
   pending.set(tabId,dialog);
   if(p.type==='alert'&&observer){
     dialog.state='responding';void debug.send(tabId,'Page.handleJavaScriptDialog',{accept:true}).catch(()=>{if(pending.get(tabId)===dialog){dialog.state='uncertain';observer.notify(dialog);}});
   }else observer?.notify(dialog);
 });
 debug.onDetach(tabId=>{const d=pending.get(tabId);if(d){d.state='uncertain';d.owned=false;}forget();});
 async function geometry(req:Req) {
   const tabId=Number(req.params.tabId),top=(await api.listFrames(tabId)).find(f=>f.frameId===0);
   if(!top)throw stale();
   const [value]=await chrome.scripting.executeScript({target:{tabId,documentIds:[top.documentId]},func:()=>({scrollX,scrollY,width:innerWidth,height:innerHeight,scale:visualViewport?.scale??1,dpr:devicePixelRatio})});
   if(!value?.result)throw stale();
   return {...value.result,operationId:String(req.params.operationId),generation:Number(req.params.generation),targetEpoch:Number(req.params.targetEpoch??0),tabId,documentId:top.documentId};
 }
 async function bitmap(data:string) {
   if(data.length>12*1024*1024)throw new ProtocolError('INVALID_PARAMS','Screenshot exceeds 9 MiB; capture a smaller region.');
   const b=await createImageBitmap(await (await fetch('data:image/png;base64,'+data)).blob());
   if(b.width*b.height>8_000_000){b.close();throw new ProtocolError('INVALID_PARAMS','Screenshot exceeds 8 million pixels; use a smaller region.');}return b;
 }
 const pixels=(b:ImageBitmap,x:number,y:number,w:number,h:number)=>{const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d')!;ctx.drawImage(b,x,y,w,h,0,0,w,h);return ctx.getImageData(0,0,w,h).data;};
 async function stableGeometry(req:Req,signal:AbortSignal) {
   let previous=await geometry(req),stableSince=Date.now();const deadline=Date.now()+1500;
   while(Date.now()<deadline){
     await interruptible(new Promise(r=>setTimeout(r,50)),signal);const next=await geometry(req);
     if(JSON.stringify(previous)!==JSON.stringify(next)){previous=next;stableSince=Date.now();}
     else if(Date.now()-stableSince>=250)return next;
   }
   throw new ProtocolError('STALE_ELEMENT','The viewport is still resizing. Capture again after it settles.','safe');
 }
 async function screenshot(req:Req,signal:AbortSignal,attempt=0):Promise<any> {
   const tabId=Number(req.params.tabId);await requireDebugger(tabId);aborted(signal);
   const before=await stableGeometry(req,signal),scope=req.params.scope??'viewport';
   if(before.scale!==1)throw new ProtocolError('ELEMENT_NOT_INTERACTABLE','Reset pinch zoom before capturing. Browser zoom is supported.');
   const metrics=await debug.send<any>(tabId,'Page.getLayoutMetrics');
   let region={x:0,y:0,width:before.width,height:before.height};
   if(scope==='fullPage')region={x:0,y:0,width:Math.ceil(metrics.cssContentSize.width),height:Math.ceil(metrics.cssContentSize.height)};
   else if(scope==='region') {const r=req.params.region as any;if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.x<0||r.y<0||r.width<=0||r.height<=0||r.x+r.width>before.width||r.y+r.height>before.height)throw new ProtocolError('INVALID_PARAMS','region must be a CSS rectangle inside the viewport.');region=r;}
   else if(scope!=='viewport')throw new ProtocolError('INVALID_PARAMS','Unknown screenshot scope.');
   if(region.width*region.height*before.dpr**2>8_000_000)throw new ProtocolError('INVALID_PARAMS','Capture is too large; use a smaller region.');
   aborted(signal);
   const shot=await interruptible(debug.send<{data:string}>(tabId,'Page.captureScreenshot',{format:'png',captureBeyondViewport:scope==='fullPage',clip:{x:region.x+(scope==='fullPage'?0:before.scrollX),y:region.y+(scope==='fullPage'?0:before.scrollY),width:region.width,height:region.height,scale:1}}),signal);
   const after=await geometry(req),c:CaptureGeometry={...before,created:Date.now(),region,imageWidth:0,imageHeight:0};try{validateCapture(c,after);}catch(error){
     // Chrome's debugger infobar animates the viewport on attach. Retry only the read, bounded.
     if(attempt<3&&error instanceof ProtocolError&&['height','width'].includes(String((error.details as any)?.changed)))return screenshot(req,signal,attempt+1);
     throw error;
   }aborted(signal);
   const image=await bitmap(shot.data);c.imageWidth=image.width;c.imageHeight=image.height;
   // A full-page image is for reading only. Action coordinates always refer to the visible viewport.
   const captureId=scope==='fullPage'?undefined:crypto.randomUUID();
   if(captureId){while(captures.size>=3){const key=captures.keys().next().value!;captures.get(key)!.bitmap.close();captures.delete(key);}captures.set(captureId,{geometry:c,bitmap:image});}else image.close();
   return {mimeType:'image/png',base64:shot.data,captureId,scope,geometry:c,coordinates:'Use image pixel coordinates with browser_pointer; capture expires after 30s or any input. Full-page images cannot authorize input.'};
 }
 async function pointer(req:Req,signal:AbortSignal,started:()=>void) {
   const p=req.params,tabId=Number(p.tabId);await requireDebugger(tabId);
   if(!await vision(p.panelRequestId,p))throw new ProtocolError('FORBIDDEN_METHOD','Visual actions require a bound panel request using a model with image input and tool calling. Select an image-capable model.');
   const id=String(p.captureId),capture=captures.get(id);if(!capture)throw stale();
   // Claim synchronously before any observation awaits. Two requests cannot spend the same image.
   captures.delete(id);forget();
   try {
     const c=capture.geometry,action=p.mode??'click';
     if(!['click','double','right','hover','drag','wheel'].includes(String(action)))throw new ProtocolError('INVALID_PARAMS','Unknown pointer mode.');
     if(typeof p.x!=='number'||typeof p.y!=='number')throw new ProtocolError('INVALID_PARAMS','Image coordinates must be numbers.');
     const from=capturePoint(c,p.x,p.y),to=action==='drag'?capturePoint(c,Number(p.toX),Number(p.toY)):undefined;
     if(action==='wheel'&&![p.deltaX??0,p.deltaY??0].every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=2000))throw new ProtocolError('INVALID_PARAMS','Wheel delta must be finite and at most 2000 CSS pixels.');
     let inspected=false,frame:Awaited<ReturnType<ChromeApi['listFrames']>>[number]|undefined;
     const comparePixels=async()=>{
       const fresh=await debug.send<{data:string}>(tabId,'Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:c.region.x+c.scrollX,y:c.region.y+c.scrollY,width:c.region.width,height:c.region.height,scale:1}});
       const image=await bitmap(fresh.data);
       try{
         if(image.width!==c.imageWidth||image.height!==c.imageHeight)throw stale();
         for(const point of [{x:Number(p.x),y:Number(p.y)},...(to?[{x:Number(p.toX),y:Number(p.toY)}]:[])]){
           const radius=Math.ceil(64*c.imageWidth/c.region.width),x=Math.max(0,Math.floor(point.x-radius)),y=Math.max(0,Math.floor(point.y-radius));
           const w=Math.min(image.width-x,radius*2),h=Math.min(image.height-y,radius*2);
           const before=pixels(capture.bitmap,x,y,w,h),after=pixels(image,x,y,w,h);
           if(before.some((v,i)=>v!==after[i]))throw new ProtocolError('STALE_ELEMENT','The target image changed. Hover, then recapture before clicking.','safe',{hovered:inspected});
         }
       }finally{image.close();}
     };
     const checked=async(phase?:string)=>{
       if(signal.aborted||!enabled())return false;
       if(phase==='continue'||phase==='release')return !signal.aborted;
       validateCapture(c,await geometry(req));
       if(!inspected){
         frame=(await api.listFrames(tabId)).find(f=>f.documentId===c.documentId);if(!frame)throw stale();await api.inject(tabId,frame);
         const prepared=await api.sendToFrame(tabId,frame,{kind:'visual-target',action:'prepare',key:req.id,points:[from,...(to?[to]:[])]});if(!prepared?.ok)throw stale();
         await comparePixels();inspected=true;
       }else if(phase==='press'){
         const verified=await api.sendToFrame(tabId,frame!,{kind:'visual-target',action:'check',key:req.id});if(!verified?.ok)throw stale();
         if(verified.needsPixels)await comparePixels();
       }
       validateCapture(c,await geometry(req));if(signal.aborted)return false;
       started();return true;
     };
     const delivered=action==='drag'?await trusted.drag(tabId,from,to!,checked,c.documentId):action==='wheel'?await trusted.wheel(tabId,from,Number(p.deltaX??0),Number(p.deltaY??0),checked,c.documentId):await trusted.click(tabId,from.x,from.y,action as any,checked,c.documentId);
     return {executed:true,verified:{trusted:true,mode:action,...('incomplete' in delivered&&delivered.incomplete?{incomplete:true,gestureIncomplete:true}:{}),...('inputRecoveryRequired' in delivered&&delivered.inputRecoveryRequired?{inputRecoveryRequired:true}:{})},nextStep:'Take a new screenshot or snapshot to check the result. The previous capture cannot be reused.'};
   } finally {capture.bitmap.close();const top=(await api.listFrames(tabId).catch(()=>[])).find(f=>f.documentId===capture.geometry.documentId);if(top)void api.sendToFrame(tabId,top,{kind:'visual-target',action:'drop',key:req.id}).catch(()=>{});}
 }
 async function dialog(req:Req,signal:AbortSignal,started:()=>void) {
   gate();const tabId=Number(req.params.tabId),d=pending.get(tabId);
   if(req.params.action==='list')return {dialogs:d&&d.operationId===req.params.operationId?[d]:[]};
   if(!d||d.dialogId!==req.params.dialogId||d.operationId!==req.params.operationId||d.generation!==req.params.generation)throw new ProtocolError('STALE_ELEMENT','The dialog has already closed or belongs to another request.');
   if(!d.owned||d.type==='beforeunload')throw new ProtocolError('FORBIDDEN_METHOD','This dialog belongs to the user. Handle it in Chrome.');
   if(d.state!=='open')throw new ProtocolError('BROWSER_BUSY','A reply is already in progress or uncertain. Inspect the dialog in Chrome.');
   if(typeof req.params.accept!=='boolean'||(req.params.text!==undefined&&(typeof req.params.text!=='string'||req.params.text.length>4000)))throw new ProtocolError('INVALID_PARAMS','Invalid dialog answer.');
   if(req.params.text!==undefined&&d.type!=='prompt')throw new ProtocolError('INVALID_PARAMS','Text is only valid for a prompt.');
   aborted(signal);d.state='responding';started();
   const respond=async()=>{
     let timer:ReturnType<typeof setTimeout>;
     try{await Promise.race([debug.send(tabId,'Page.handleJavaScriptDialog',{accept:req.params.accept,...(req.params.text!==undefined?{promptText:req.params.text}:{})}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Dialog response timed out')),5000);})]);}
     catch(error){if(pending.get(tabId)===d){if(/no dialog/i.test(String(error))){pending.delete(tabId);throw new ProtocolError('STALE_ELEMENT','The dialog was already closed.');}d.state='uncertain';}throw new ProtocolError('EXECUTION_UNKNOWN','The dialog response could not be confirmed. Inspect it in Chrome; do not repeat the original action.','unsafe');}
     finally{clearTimeout(timer!);}
     const inputs=[...works.values()].filter(w=>w.tabId===tabId&&w.method!=='browser.dialog').map(w=>w.promise);
     if(inputs.length){let timer:ReturnType<typeof setTimeout>;try{await Promise.race([Promise.allSettled(inputs),new Promise(r=>{timer=setTimeout(r,1500);})]);}finally{clearTimeout(timer!);}}
     let statusUnknown=false;const recovery=await inputStatus?.(tabId).catch(()=>{statusUnknown=true;return undefined;});
     return {ok:true,result:{executed:true,verified:{dialogAnswered:true,...(statusUnknown?{inputRecoveryUnknown:true}:{}),...(recovery?.required?{inputRecoveryRequired:true,gestureIncomplete:true}:{}),...(recovery?.pending?{inputCleanupPending:true}:{})},nextStep:'Observe the original action outcome; do not repeat its click.'}};
   };
   return (await race(req,respond,true)).result;
 }
 async function race(req:Req,work:()=>Promise<any>,responding=false) {
   if(!enabled()||!advancedAvailable())return work();
   const tabId=Number(req.params.tabId);
   if(!responding&&pending.has(tabId))throw new ProtocolError('BROWSER_BUSY','Respond to the pending browser_dialog before another page action.');
   let resolve!:(v:any)=>void;
   const notice=new Promise(r=>{resolve=r;});
   observers.set(tabId,{req,notify:d=>resolve({ok:true,result:{executed:true,verified:{dialogPending:true,gestureIncomplete:true},dialog:d}})});
   const original=Promise.resolve().then(work);
   works.set(req.id,{tabId,method:req.method,promise:original});
   const retire=()=>{works.delete(req.id);setTimeout(()=>{if(observers.get(tabId)?.req.id===req.id)observers.delete(tabId);},1500);};
   void original.then(retire,retire);
   return Promise.race([original,notice]);
 }

 return {
   enabled:()=>enabled()&&advancedAvailable(),clear:forget,
   pending:(tabId:number)=>pending.get(tabId),
   race,
   inflight:(id:string)=>works.get(id)?.promise,
   busy:(tabId:number)=>[...works.values()].some(w=>w.tabId===tabId),
   reset:()=>{forget();pending.clear();observers.clear();},
   async handle(req:Req,signal:AbortSignal,started:()=>void) {
     gate();aborted(signal);
     if(req.method!=='browser.dialog'&&pending.has(Number(req.params.tabId)))throw new ProtocolError('BROWSER_BUSY','A browser dialog is open.');
     if(req.method==='browser.screenshot')return screenshot(req,signal);
     if(req.method==='browser.dialog')return dialog(req,signal,started);
     if(req.method==='browser.pointer')return (await this.race(req,async()=>({ok:true,result:await pointer(req,signal,started)}))).result;
     throw new ProtocolError('INVALID_PARAMS','Unknown advanced method.');
   },
 };
}
export type AdvancedBrowser=ReturnType<typeof advancedBrowser>;
