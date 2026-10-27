import type { InputRecovery, InputDocument } from './input-recovery';
/** Chrome's debugger, attached only to this browser's operation tabs while the user enabled
 * trusted input, so clicks and keys arrive as real user input (review B3, handoff §10 R10). */
export type DebuggerApi = {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<T = unknown>(tabId: number, method: string, params?: object): Promise<T>;
  onDetach(listener: (tabId: number, reason: string) => void): () => void;
  onEvent(listener: (tabId: number, method: string, params: any) => void): () => void;
};
export type InputPhase = "prepare" | "press" | "continue" | "release" | "keyRelease";
export type ActiveInput = (phase?:InputPhase) => boolean | Promise<boolean>;
type InputStep=(()=>Promise<unknown>) & {phase?:InputPhase};
const step=(run:()=>Promise<unknown>,phase:InputPhase):InputStep=>Object.assign(run,{phase});
export type TrustedState = { enabled: boolean; operationTabs: number[]; operationId?: string | null };
export type Dialog = { type: string; message: string };

const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};
/** CDP modifier bits and the key each modifier presses. */
const MODIFIER_KEYS: Record<string, { bit: number; key: string; code: string; windowsVirtualKeyCode: number }> = {
  Alt: { bit: 1, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { bit: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { bit: 4, key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { bit: 8, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 },
};
/** Real input with Control, Meta or Alt can reach Chrome's own shortcuts (paste the person's clipboard,
 * close or switch tabs, open menus or devtools). Only page editing shortcuts are sent; others stay DOM events. */
const SHORTCUT_KEYS = new Set(["a", "z", "y", "b", "i", "Enter", "Backspace", "Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const SHIFT_KEYS = new Set(["Enter", "Tab", "Space", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
export function trustedShortcut(key: string, modifiers: string[]): boolean {
  if (modifiers.length === 0) return true;
  // Shift alone is typing or selecting, except combinations such as Shift+Escape (Chrome's task manager).
  if (modifiers.every(m => m === "Shift")) return /^[a-zA-Z0-9]$/.test(key) || SHIFT_KEYS.has(key);
  if (modifiers.includes("Alt") || modifiers.includes("Control") === modifiers.includes("Meta")) return false;
  const single = /^[a-zA-Z]$/.test(key), name = single ? key.toLowerCase() : key;
  if (!SHORTCUT_KEYS.has(name)) return false;
  return !modifiers.includes("Shift") || !single || name === "z";
}
function keySpec(key: string, modifiers: string[]) {
  if (KEYS[key]) return KEYS[key];
  if (modifiers.length === 0 || !/^[a-zA-Z0-9]$/.test(key)) return undefined;
  const upper = key.toUpperCase(), shift = modifiers.includes("Shift");
  return { key: /\d/.test(key) ? key : shift ? upper : key.toLowerCase(), code: /\d/.test(key) ? `Digit${key}` : `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: /\d/.test(key) ? key : shift ? upper : key.toLowerCase() };
}

/** The input state for this browser: its operation's tabs, none while the person holds the browser. */
export function trustedTargets(operation: { id?: string; clientId?: string; tabs?: number[]; paused?: boolean } | null, clientId: string | undefined, enabled: boolean): TrustedState & { operationId: string | null } {
  const mine = operation && clientId && operation.clientId === clientId ? operation : null;
  return { enabled, operationTabs: mine && !mine.paused ? mine.tabs ?? [] : [], operationId: mine?.id ?? null };
}

/** An attempted input may have reached the page even if its first callback failed. */
export class PartlyDelivered extends Error { readonly dispatched = true; constructor(message:string,readonly inputRecoveryRequired=false){super(message);} }
class InputNotDelivered extends Error {
  readonly dispatched = false;
  constructor(message: string, readonly cancelled = false) { super(message); }
}

export function trustedInput(api: DebuggerApi, advanced = () => false, recovery?:InputRecovery) {
  const attached = new Set<number>();
  const sessions=new Map<number,number>(),detaching=new Set<number>();let nextSession=0;
  type Held={id:string;tabId:number;session:number|undefined;operation:string|null|undefined;document?:InputDocument;active:ActiveInput;lease:boolean;keys:Map<string,Record<string,unknown>>;upAttempts:Set<string>;mouse?:Record<string,unknown>;attempted:boolean;pressed:boolean;settled:boolean;quarantined:boolean;epoch:number;cleanupDeadline?:number};
  const heldInputs=new Map<number,Held>();
  const outstanding=(h:Held)=>!!h.mouse||h.keys.size>0;
  const owns=(h:Held)=>attached.has(h.tabId)&&sessions.get(h.tabId)===h.session&&operationId===h.operation&&!isCancelled();
  async function markUnresolved(h:Held){
    if(!outstanding(h)||h.settled)return;
    h.quarantined=true;
    if(h.document&&h.lease)await recovery?.finish(h.document,h.id,true).catch(()=>{});
  }

  // [Cancel] on Chrome's debugging bar applies to the whole operation, not one tab.
  let cancelled: { operationId: string | null | undefined; reason: string } | undefined;
  const dialogs = new Map<number, Dialog>();
  const dialogEpoch=new Map<number,number>(), openDialogs=new Set<number>();
  // Dialogs are answered only during an agent input and shortly after; others belong to the person.
  const inputUntil = new Map<number, number>();
  let operationId: string | null | undefined;
  let current: TrustedState = { enabled: false, operationTabs: [] };
  // Attach, detach and sync run one at a time, so a session can never escape tracking.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.catch(() => {}); return next; };

  api.onDetach((tabId, reason) => {
    const held=heldInputs.get(tabId);if(held)void markUnresolved(held);
    attached.delete(tabId);sessions.delete(tabId);
    if (reason === "canceled_by_user") cancelled = { operationId, reason };
  });
  api.onEvent((tabId, method, params) => {
    if(method==='Page.javascriptDialogClosed'){openDialogs.delete(tabId);return;}
    if (method !== "Page.javascriptDialogOpening" || !attached.has(tabId)) return;
    openDialogs.add(tabId);dialogEpoch.set(tabId,(dialogEpoch.get(tabId)??0)+1);
    if(advanced())return;
    if (!((inputUntil.get(tabId) ?? 0) >= Date.now())) return;
    // An alert only informs; a confirm, prompt or leave-page question is the user's decision.
    const accept = params?.type === "alert";
    dialogs.set(tabId, { type: String(params?.type ?? "unknown"), message: String(params?.message ?? "").slice(0, 200) });
    void api.send(tabId, "Page.handleJavaScriptDialog", { accept }).catch(() => {});
  });

  const takeDialog = (tabId: number) => { const dialog = dialogs.get(tabId); dialogs.delete(tabId); return dialog ? { dialog } : {}; };
  const isCancelled = () => !!cancelled && cancelled.operationId === operationId;

  async function release(tabId: number) {
    const held=heldInputs.get(tabId);if(held)await markUnresolved(held);
    const wasAttached=attached.has(tabId);
    attached.delete(tabId);sessions.delete(tabId);dialogs.delete(tabId);inputUntil.delete(tabId);openDialogs.delete(tabId);
    if(!wasAttached||detaching.has(tabId))return;
    detaching.add(tabId);
    const original=Promise.resolve().then(()=>api.detach(tabId));
    // A timeout does not cancel detach: fence reattachment until the actual callback settles.
    void original.then(()=>detaching.delete(tabId),()=>detaching.delete(tabId));
    let timer:ReturnType<typeof setTimeout>;
    try { await Promise.race([original,new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]).catch(()=>{}); }
    finally { clearTimeout(timer!); }
  }
  const inputs=new Map<number,Promise<unknown>>();
  async function sameDocument(h:Held){return !h.document||await recovery!.current(h.document);}
  async function sendInput(tabId:number,method:string,params:Record<string,unknown>) {
    const held=heldInputs.get(tabId);
    if(!held||!owns(held)||!await sameDocument(held))throw new InputNotDelivered('The input document or debugger session changed.',true);
    const keyDown=method==='Input.dispatchKeyEvent'&&params.type==='keyDown';
    const mouseDown=method==='Input.dispatchMouseEvent'&&params.type==='mousePressed';
    if((keyDown||mouseDown)&&!held.lease&&held.document){await recovery!.begin(held.document,held.id);held.lease=true;}
    // Persistence and document checks may yield. Never send a new down after cancellation.
    if(!owns(held)||!await sameDocument(held))throw new InputNotDelivered('The input document changed before dispatch.',true);
    const cleanup=held.cleanupDeadline!==undefined;
    if(!cleanup&&!await held.active('continue'))throw new InputNotDelivered('The input ended before dispatch.',true);
    if(!current.enabled||!current.operationTabs.includes(tabId)||!cleanup&&(dialogEpoch.get(tabId)??0)!==held.epoch)throw new InputNotDelivered('The input was interrupted before dispatch.',true);
    if(cleanup&&!(method==='Input.dispatchKeyEvent'&&params.type==='keyUp'))throw new InputNotDelivered('Only held key releases may finish after interruption.',true);
    if(!owns(held)||(held.cleanupDeadline!==undefined&&Date.now()>=held.cleanupDeadline))throw new InputNotDelivered('Input cleanup is no longer authorized.',true);
    if(keyDown)held.keys.set(String(params.key),params);
    if(mouseDown)held.mouse=params;
    if(method==='Input.dispatchKeyEvent'&&params.type==='keyUp')held.upAttempts.add(String(params.key));
    held.attempted=true;
    if(keyDown||mouseDown||method==='Input.insertText'||params.type==='mouseWheel')held.pressed=true;
    const result=await api.send(tabId,method,params);
    if(method==='Input.dispatchKeyEvent'&&params.type==='keyUp'){held.keys.delete(String(params.key));held.upAttempts.delete(String(params.key));}
    if(method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased')held.mouse=undefined;
    return result;
  }
  function deliver(tabId:number,steps:InputStep[],active:ActiveInput,sourceDocumentId?:string) {
    const owner=operationId,session=sessions.get(tabId),document=recovery?.capture(tabId,sourceDocumentId);
    void document?.catch(()=>{});
    const next=(inputs.get(tabId)??Promise.resolve()).then(async()=>{
      const captured=await document?.catch(error=>{throw Object.assign(error instanceof Error?error:Error(String(error)),{dispatched:false,verificationFailed:true});});
      if(owner!==operationId||session!==sessions.get(tabId)||!attached.has(tabId)||captured&&!await recovery!.current(captured))throw new InputNotDelivered('The queued input context changed.',true);
      return deliverNow(tabId,steps,active,captured,owner,session);
    });
    const tail=next.catch(()=>{});inputs.set(tabId,tail);void tail.then(()=>{if(inputs.get(tabId)===tail)inputs.delete(tabId);});return next;
  }
  async function settle(h:Held,interrupted:boolean){
    const hadKeys=h.keys.size>0,deadline=Date.now()+1000;
    if(interrupted){
      h.cleanupDeadline=deadline;
      const drain=async()=>{
        for(const key of [...h.keys.values()].reverse()){
          const name=String(key.key);
          // An uncertain up must not be replayed; Space-up could activate a button.
          if(h.upAttempts.has(name)||key.code==='Space'||name===' ')continue;
          if(Date.now()>=h.cleanupDeadline!||openDialogs.has(h.tabId)||!owns(h)||!await sameDocument(h))break;
          const modifiers=[...h.keys.keys()].filter(k=>k!==name).reduce((bits,k)=>bits|(MODIFIER_KEYS[k]?.bit??0),0);
          await sendInput(h.tabId,'Input.dispatchKeyEvent',{type:'keyUp',key:key.key,code:key.code,windowsVirtualKeyCode:key.windowsVirtualKeyCode,modifiers});
        }
      };
      let timer:ReturnType<typeof setTimeout>;
      try{await Promise.race([drain(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Input cleanup timed out')),1000);})]);}
      catch{}finally{clearTimeout(timer!);h.cleanupDeadline=0;}
    }

    let uncertain=h.quarantined||outstanding(h);
    if(h.document&&h.lease){try{await recovery!.finish(h.document,h.id,uncertain);}catch{uncertain=true;}}
    h.settled=true;
    if(uncertain)await release(h.tabId);
    return {...(hadKeys?{keysReleased:h.keys.size===0}:{}),...(uncertain?{inputRecoveryRequired:true}:{})};
  }
  async function deliverNow(tabId:number,steps:InputStep[],active:ActiveInput,document:InputDocument|undefined,owner:string|null|undefined,session:number|undefined) {
    const held:Held={id:crypto.randomUUID(),tabId,session,operation:owner,document,active,lease:false,keys:new Map(),upAttempts:new Set(),attempted:false,pressed:false,settled:false,quarantined:false,epoch:dialogEpoch.get(tabId)??0};
    heldInputs.set(tabId,held);inputUntil.set(tabId,Number.POSITIVE_INFINITY);
    const initialEpoch=dialogEpoch.get(tabId)??0;
    let interrupted=false,failed=false,failure:unknown;
    try{
      for(const next of steps){
        if((dialogEpoch.get(tabId)??0)!==initialEpoch){interrupted=true;break;}
        const phase=next.phase??'press';
        if(!await active(phase==='keyRelease'?'continue':phase)){
          if(held.pressed){interrupted=true;break;}
          throw new InputNotDelivered('The input request was cancelled before its gesture.',true);
        }
        if(!owns(held)||!current.enabled||!current.operationTabs.includes(tabId))throw new InputNotDelivered('The debugger session changed.',true);
        let timer:ReturnType<typeof setTimeout>,watch:ReturnType<typeof setInterval>,checking=false;
        const stopped=new Promise<never>((_,reject)=>{
          watch=setInterval(()=>{if(checking)return;checking=true;void Promise.resolve().then(async()=>{if(!owns(held)||!await active('continue'))reject(new InputNotDelivered('The pending input was stopped.',true));}).catch(reject).finally(()=>{checking=false;});},100);
          const expired=()=>{if(openDialogs.has(tabId)&&owns(held))timer=setTimeout(expired,1000);else reject(Error('CDP input reply timed out'));};timer=setTimeout(expired,7000);
        });
        try{await Promise.race([next(),stopped]);}finally{clearTimeout(timer!);clearInterval(watch!);}
      }
    }catch(error){failure=error;failed=true;interrupted=true;}
    try{
      // A command may acknowledge before its modal closes. Keep its queue slot until the
      // existing dialog response/user flow completes; cancellation is checked independently.
      while(interrupted&&openDialogs.has(tabId)&&owns(held)&&await active('continue'))await new Promise(r=>setTimeout(r,25));
      const notice=takeDialog(tabId);
      const cleanup=await settle(held,interrupted);
      if(failed){
        if(held.pressed||(held.attempted&&!(failure instanceof InputNotDelivered)&&!(failure as any)?.verificationFailed&&(failure as any)?.code!=='STALE_ELEMENT'))throw new PartlyDelivered(failure instanceof Error?failure.message:String(failure),cleanup.inputRecoveryRequired===true);
        if(failure&&typeof failure==='object')Object.assign(failure,{dispatched:false,verificationFailed:!('cancelled' in failure&&failure.cancelled)});
        throw failure;
      }
      return {...notice,...takeDialog(tabId),...(interrupted?{incomplete:true,...cleanup}:{})};
    }finally{
      if(heldInputs.get(tabId)===held)heldInputs.delete(tabId);
      if(held.attempted&&owns(held))inputUntil.set(tabId,Date.now()+1500);else inputUntil.delete(tabId);
    }
  }

  return {
    ensure(tabId: number, state: TrustedState): Promise<boolean> {
      return serial(async () => {
        if (state.operationId !== undefined && state.operationId !== operationId) { operationId = state.operationId; if (cancelled && cancelled.operationId !== operationId) cancelled = undefined; }
        current = state;
        if (!state.enabled || !state.operationTabs.includes(tabId) || isCancelled() || detaching.has(tabId)) return false;
        if (attached.has(tabId)) return true;
        try {
          await api.attach(tabId);
          attached.add(tabId);sessions.set(tabId,++nextSession);
          await api.send(tabId, "Page.enable");
          return true;
        } catch { await release(tabId); return false; }
      });
    },
    sync(state: TrustedState & { operationId: string | null }): Promise<void> {
      return serial(async () => {
        if (state.operationId !== operationId) { cancelled = undefined; operationId = state.operationId; }
        current = state;
        for (const tabId of [...attached]) if (!state.enabled || !state.operationId || !state.operationTabs.includes(tabId)) await release(tabId);
      });
    },
    click(tabId: number, x: number, y: number, mode: ClickMode = "click", active:ActiveInput = () => true,sourceDocumentId?:string) {
      const mouse = (params: Record<string,unknown>, phase:InputPhase="prepare") => step(() => sendInput(tabId, "Input.dispatchMouseEvent", params), phase);
      const button = mode === "right" ? "right" as const : "left" as const;
      const steps = [mouse({ type: "mouseMoved", x, y })];
      if (mode !== "hover") for (const clickCount of mode === "double" ? [1, 2] : [1])
        steps.push(mouse({ type: "mousePressed", x, y, button, clickCount },"press"), mouse({ type: "mouseReleased", x, y, button, clickCount },"release"));
      return deliver(tabId, steps, active,sourceDocumentId);
    },
    drag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }, active:ActiveInput = () => true,sourceDocumentId?:string) {
      const mouse = (params: Record<string,unknown>, phase:InputPhase="prepare") => step(() => sendInput(tabId, "Input.dispatchMouseEvent", params), phase);
      const steps = [mouse({ type: "mouseMoved", ...from }), mouse({ type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 },"press")];
      for (const f of [0.25, 0.5, 0.75, 1]) steps.push(mouse({ type: "mouseMoved", x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, button: "left", buttons: 1 },"release"));
      steps.push(mouse({ type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 },"release"));
      return deliver(tabId, steps, active,sourceDocumentId);
    },
    key(tabId: number, key: string, modifiers: string[] = [], active:ActiveInput = () => true,sourceDocumentId?:string) {
      const spec = keySpec(key, modifiers);
      if (!spec || modifiers.some(m => !MODIFIER_KEYS[m]) || !trustedShortcut(key, modifiers)) return Promise.reject(new InputNotDelivered(`Unsupported key ${key}`));
      const send = (params: Record<string,unknown>) => step(() => sendInput(tabId, "Input.dispatchKeyEvent", params),params.type==="keyUp"?"keyRelease":"press");
      const held = modifiers.map(m => MODIFIER_KEYS[m]!);
      const bits = held.reduce((sum, m) => sum | m.bit, 0);
      // A key with Control, Alt or Meta is a shortcut, not typing.
      const { text, ...up } = spec;
      const typed = modifiers.every(m => m === "Shift") && text !== undefined ? { text } : {};
      const steps: InputStep[] = [];
      let down = 0;
      for (const m of held) { down |= m.bit; const { bit: _bit, ...k } = m; steps.push(send({ type: "keyDown", ...k, modifiers: down })); }
      steps.push(send({ type: "keyDown", ...up, ...typed, ...(bits ? { modifiers: bits } : {}) }), send({ type: "keyUp", ...up, ...(bits ? { modifiers: bits } : {}) }));
      for (const m of [...held].reverse()) { down &= ~m.bit; const { bit: _bit, ...k } = m; steps.push(send({ type: "keyUp", ...k, ...(down ? { modifiers: down } : {}) })); }
      return deliver(tabId, steps, active,sourceDocumentId);
    },
    wheel(tabId:number,point:{x:number;y:number},deltaX:number,deltaY:number,active:ActiveInput=()=>true,sourceDocumentId?:string) {
      return deliver(tabId,[step(()=>sendInput(tabId,'Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX,deltaY}),'press')],active,sourceDocumentId);
    },
    text(tabId:number,text:string,active:ActiveInput=()=>true,sourceDocumentId?:string) {
      return deliver(tabId, text ? [step(()=>sendInput(tabId,"Input.insertText",{text}),"press")] : [step(()=>sendInput(tabId,"Input.dispatchKeyEvent",{type:"keyDown",key:"Backspace",code:"Backspace",windowsVirtualKeyCode:8}),"press"),step(()=>sendInput(tabId,"Input.dispatchKeyEvent",{type:"keyUp",key:"Backspace",code:"Backspace",windowsVirtualKeyCode:8}),"keyRelease")], active,sourceDocumentId);
    },
    async screenshot(tabId: number) {
      const { data } = await api.send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "png" });
      return `data:image/png;base64,${data}`;
    },
    cancelledReason: (_tabId: number) => isCancelled() ? cancelled!.reason : undefined,
    isStopping:(tabId:number)=>detaching.has(tabId),
    isAttached: (tabId: number) => attached.has(tabId) && current.operationTabs.includes(tabId),
  };
}
export type TrustedInput = ReturnType<typeof trustedInput>;
export type ClickMode = "click" | "double" | "right" | "hover";

/** chrome.debugger behind the small interface above. */
export function chromeDebugger(): DebuggerApi {
  const wrap = <T>(work: (done: (value: T) => void) => void) => new Promise<T>((resolve, reject) =>
    work(value => { const error = chrome.runtime.lastError; error ? reject(new Error(error.message)) : resolve(value); }));
  return {
    attach: tabId => wrap<void>(done => chrome.debugger.attach({ tabId }, "1.3", () => done())),
    detach: tabId => wrap<void>(done => chrome.debugger.detach({ tabId }, () => done())),
    send: (tabId, method, params) => wrap(done => chrome.debugger.sendCommand({ tabId }, method, (params ?? {}) as { [key: string]: unknown }, result => done(result as any))),
    onDetach: listener => { const fn = (source: chrome.debugger.Debuggee, reason: string) => { if (source.tabId !== undefined) listener(source.tabId, reason); }; chrome.debugger.onDetach.addListener(fn); return () => chrome.debugger.onDetach.removeListener(fn); },
    onEvent: listener => { const fn = (source: chrome.debugger.Debuggee, method: string, params?: object) => { if (source.tabId !== undefined) listener(source.tabId, method, params); }; chrome.debugger.onEvent.addListener(fn); return () => chrome.debugger.onEvent.removeListener(fn); },
  };
}
