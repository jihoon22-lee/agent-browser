import type {InputRecovery} from '../src/background/input-recovery';
import { trustedInput, type DebuggerApi } from '../src/background/trusted-input';
function fixture(advanced=true,recovery?:InputRecovery) {
 const calls:{method:string;params:any}[]=[];
 let event!:(tab:number,method:string,params:any)=>void;
 const api:DebuggerApi={attach:vi.fn(async()=>{}),detach:vi.fn(async()=>{}),onDetach:()=>()=>{},onEvent:fn=>{event=fn;return()=>{};},send:vi.fn(async(methodTab,method,params)=>{calls.push({method,params});return {} as any;})};
 const input=trustedInput(api,()=>advanced,recovery);
 return {input,api,calls,event:(method:string,params={})=>event(1,method,params)};
}
it.each([false,true])('releases held keys after a dialog interruption (advanced=%s)',async advanced=>{
 const f=fixture(advanced);await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(method==='Input.dispatchKeyEvent'&&p.type==='keyDown'&&p.key==='Enter'){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}return r as any;};
 await expect(f.input.key(1,'Enter',['Control'])).resolves.toMatchObject({incomplete:true});
 const keys=f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>[c.params.type,c.params.key]);
 expect(keys).toEqual([['keyDown','Control'],['keyDown','Enter'],['keyUp','Enter'],['keyUp','Control']]);
});
it('a dialog during a modifier never sends the remaining key downs',async()=>{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(method==='Input.dispatchKeyEvent'&&p.type==='keyDown'){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}return r as any;};
 await f.input.key(1,'z',['Control','Shift']);
 expect(f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>[c.params.type,c.params.key])).toEqual([['keyDown','Control'],['keyUp','Control']]);
});

it('releases the modifier left after a main-key-up dialog with the correct modifier bits',async()=>{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(method==='Input.dispatchKeyEvent'&&p.type==='keyUp'&&p.key==='Enter'){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}return r as any;};
 const r=await f.input.key(1,'Enter',['Control']);expect(r).toMatchObject({incomplete:true,keysReleased:true});expect(f.calls.filter(c=>c.params?.type==='keyUp').map(c=>[c.params.key,c.params.modifiers??0])).toEqual([['Enter',2],['Control',0]]);
});
it('stopping after a modifier drains it without sending the principal key',async()=>{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;let active=true;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(p?.type==='keyDown')active=false;return r as any;};
 expect(await f.input.key(1,'Enter',['Control'],()=>active)).toMatchObject({incomplete:true,keysReleased:true});expect(f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>[c.params.type,c.params.key])).toEqual([['keyDown','Control'],['keyUp','Control']]);
});
it('never invents mouseup or Space-up after an interruption',async()=>{
 for(const kind of ['mouse','space']){
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(['mousePressed','keyDown'].includes(p?.type)){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}return r as any;};
 const r=kind==='mouse'?await f.input.click(1,20,30):await f.input.key(1,'Space');expect(r).toMatchObject({incomplete:true,inputRecoveryRequired:true});expect(f.calls.some(c=>['keyUp','mouseReleased'].includes(c.params?.type))).toBe(false);expect(f.api.detach).toHaveBeenCalledTimes(1);
 }
});
it('a lost key-up response is not retried by cleanup or a later gesture',async()=>{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(p?.type==='keyUp'&&p.key==='Enter')throw Error('lost reply');return r as any;};
 await expect(f.input.key(1,'Enter',['Control'])).rejects.toMatchObject({inputRecoveryRequired:true});expect(f.calls.filter(c=>c.params?.type==='keyUp'&&c.params.key==='Enter')).toHaveLength(1);expect(f.calls.filter(c=>c.params?.type==='keyUp'&&c.params.key==='Control')).toHaveLength(1);
});
it('queued input waits for cleanup and cannot use a detached old context',async()=>{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;let acknowledge!:()=>void;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(p?.type==='keyDown'&&p.key==='Enter'){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}if(p?.type==='keyUp'&&p.key==='Enter')await new Promise<void>(resolve=>{acknowledge=resolve;});return r as any;};
 const first=f.input.key(1,'Enter',['Control']);await vi.waitFor(()=>expect(acknowledge).toBeTypeOf('function'));const second=f.input.key(1,'ArrowRight');expect(f.calls.some(c=>c.params?.key==='ArrowRight')).toBe(false);acknowledge();await first;await second;
 const keys=f.calls.filter(c=>c.method==='Input.dispatchKeyEvent').map(c=>`${c.params.type} ${c.params.key}`);expect(keys.indexOf('keyUp Control')).toBeLessThan(keys.indexOf('keyDown ArrowRight'));
});
it('a cleanup-created modal is bounded and an unsettled detach fences reattachment',async()=>{
 vi.useFakeTimers();try{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(p?.type==='keyDown'){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}if(p?.type==='keyUp'){f.event('Page.javascriptDialogOpening',{type:'confirm'});return new Promise(()=>{});}return r as any;};
 let detached!:()=>void;f.api.detach=()=>new Promise<void>(resolve=>{detached=resolve;});
 const result=f.input.key(1,'Enter');await vi.advanceTimersByTimeAsync(2500);expect(await result).toMatchObject({incomplete:true,inputRecoveryRequired:true});expect(await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'})).toBe(false);detached();await Promise.resolve();
 }finally{vi.useRealTimers();}
});
it('cancellation breaks a pending modal command without a key replay',async()=>{
 vi.useFakeTimers();try{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;let active=true;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(p?.type==='keyDown'){f.event('Page.javascriptDialogOpening',{type:'confirm'});return new Promise(()=>{});}return r as any;};
 const result=f.input.key(1,'Enter',[],()=>active).catch(e=>e);await vi.advanceTimersByTimeAsync(10);active=false;await vi.advanceTimersByTimeAsync(200);expect(await result).toMatchObject({dispatched:true,inputRecoveryRequired:true});expect(f.calls.filter(c=>c.params?.type==='keyDown')).toHaveLength(1);expect(f.calls.filter(c=>c.params?.type==='keyUp')).toHaveLength(0);
 }finally{vi.useRealTimers();}
});

it.each([{modifiers:[]},{modifiers:['Shift']}])('cancelling after Space down cannot activate via the normal release ($modifiers)',async({modifiers})=>{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;let active=true;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(p?.type==='keyDown'&&p.code==='Space')active=false;return r as any;};
 expect(await f.input.key(1,'Space',modifiers,()=>active)).toMatchObject({incomplete:true,inputRecoveryRequired:true});expect(f.calls.some(c=>c.params?.type==='keyUp'&&c.params.code==='Space')).toBe(false);
});
it.each(['release','move','text','dialog'])('rechecks cancellation/dialog after the final document await before %s',async kind=>{
 let active=true,queries=0,gate!:()=>void;
 const recovery={capture:async()=>({tabId:1,documentId:'doc'}),current:async()=>{queries++;if(queries===(kind==='text'?3:7))await new Promise<void>(resolve=>{gate=resolve;});return true;},begin:async()=>{},finish:async()=>{}} as unknown as InputRecovery;
 const f=fixture(true,recovery);await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});
 const task=(kind==='text'?f.input.text(1,'x',()=>active):kind==='move'?f.input.drag(1,{x:1,y:1},{x:10,y:10},()=>active):f.input.click(1,1,1,'click',()=>active)).catch(e=>e);
 await vi.waitFor(()=>expect(gate).toBeTypeOf('function'));
 if(kind==='dialog'){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}else active=false;
 const before=f.calls.length;gate();await task;
 expect(f.calls.slice(before).filter(c=>c.method.startsWith('Input.'))).toEqual([]);
});
it('detach rejection is settled and does not fence the tab forever',async()=>{
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});f.api.detach=async()=>{throw Error('not attached');};await f.input.sync({enabled:false,operationTabs:[],operationId:null});expect(f.input.isStopping(1)).toBe(false);expect(await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'next'})).toBe(true);
});
it('an acknowledged final release with a dialog is a complete gesture',async()=>{
 for(const mouse of [false,true]){
 const f=fixture();await f.input.ensure(1,{enabled:true,operationTabs:[1],operationId:'op'});const send=f.api.send;
 f.api.send=async(tab,method,p:any)=>{const r=await send(tab,method,p);if(p?.type==='mouseReleased'||p?.type==='keyUp'&&p.key==='Control'){f.event('Page.javascriptDialogOpening',{type:'alert'});f.event('Page.javascriptDialogClosed');}return r as any;};
 const r=mouse?await f.input.click(1,2,2):await f.input.key(1,'Enter',['Control']);expect(r).not.toHaveProperty('incomplete');expect(r).not.toHaveProperty('inputRecoveryRequired');
 }
});
