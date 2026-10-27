import { runAction } from '../src/content/actions';
import { resetRegistry } from '../src/content/refs';
import { takeSnapshot } from '../src/content/snapshot';

beforeEach(() => { document.body.innerHTML = '<button>Submit</button><button>Drop</button>'; resetRegistry(); });
afterEach(() => vi.unstubAllGlobals());
const refs = () => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 100, offset: 0, checkLayout: false }).elements.map(element => element.ref);

it.each(['click', 'press', 'drag'])('does not repeat %s when the trusted reply is lost after dispatch', async action => {
  const [ref, toRef] = refs(), target = document.querySelectorAll('button')[action === 'drag' ? 1 : 0]!;
  const type = action === 'drag' ? 'pointerup' : 'click', delivered = vi.fn();
  target.addEventListener(type, delivered);
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    throw new Error('The message port closed before a response was received.');
  } } });
  const result = await runAction(action === 'drag' ? 'click' : action, {
    ref, trusted: true, waitFor: { text: 'Done' },
    ...(action === 'press' ? { key: 'Enter' } : action === 'drag' ? { mode: 'drag', toRef } : {}),
  }).catch(error => ({ error }));
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ error: { code: 'EXECUTION_UNKNOWN', retry: 'unsafe' } });
});

it.each([undefined, {}, { ok: false, reason: 'unavailable' }])('does not treat an ambiguous reply %j as proof that no input ran', async answer => {
  const [ref] = refs(), delivered = vi.fn();
  document.querySelector('button')!.addEventListener('click', delivered);
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => answer } });
  const result = await runAction('click', { ref, trusted: true, waitFor: { text: 'Done' } }).catch(error => ({ error }));
  expect(delivered).not.toHaveBeenCalled();
  expect(result).toMatchObject({ error: { code: 'EXECUTION_UNKNOWN', retry: 'unsafe' } });
});

it('permits one fallback only after an explicit reply that no input was dispatched', async () => {
  const [ref] = refs(), delivered = vi.fn();
  document.querySelector('button')!.addEventListener('click', delivered);
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => ({ ok: false, reason: 'not-allowed', dispatched: false }) } });
  await expect(runAction('click', { ref, trusted: true, waitFor: { text: 'Done' } })).resolves.toMatchObject({ executed: true, verified: { trusted: false } });
  expect(delivered).toHaveBeenCalledTimes(1);
});

it('honors background cancellation before the separate content cancel arrives', async () => {
  const [ref] = refs(), delivered = vi.fn();
  document.querySelector('button')!.addEventListener('click', delivered);
  vi.stubGlobal('chrome', { runtime: { sendMessage: async () => ({ ok: false, reason: 'not-allowed', dispatched: false, cancelled: true }) } });
  await expect(runAction('click', { ref, trusted: true, waitFor: { text: 'Done' } })).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(delivered).not.toHaveBeenCalled();
});

it.each([0, 50, 100, 150, 200, 250])('lost native-fill replies never duplicate a DOM edit (50 cases starting at %i)',async start=>{
 for(let n=start;n<start+50;n++){
  document.body.innerHTML='<input aria-label="Name">';resetRegistry();const input=document.querySelector('input')!;
  const ref=takeSnapshot({snapshotId:n+1,frameId:0,maxChars:100,offset:0,checkLayout:false}).elements[0]!.ref;
  let inputs=0;input.addEventListener('input',()=>inputs++);
  vi.stubGlobal('chrome',{runtime:{sendMessage:async()=>{input.value='native';input.dispatchEvent(new Event('input'));throw Error('reply lost');}}});
  await expect(runAction('fill',{requestId:'lost-'+n,ref,text:'requested',trusted:true,trustedFrames:true})).rejects.toMatchObject({code:'EXECUTION_UNKNOWN'});
  expect(inputs).toBe(1);expect(input.value).toBe('native');
 }
});

it.each(['press','fill','click'])('preserves incomplete trusted %s metadata',async action=>{
 document.body.innerHTML='<input aria-label="Text">';resetRegistry();const [ref]=refs();
 vi.stubGlobal('chrome',{runtime:{sendMessage:async()=>({ok:true,incomplete:true,keysReleased:false,inputRecoveryRequired:true})}});
 const r=await runAction(action,{requestId:'partial-'+action,ref,...(action==='press'?{key:'Enter'}:{text:''}),trusted:true,trustedFrames:true,waitFor:{text:'done'}});
 expect(r.verified).toMatchObject({incomplete:true,inputRecoveryRequired:true,keysReleased:false});
});
