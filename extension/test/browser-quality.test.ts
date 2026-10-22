import { takeSnapshot } from '../src/content/snapshot';
import { resetRegistry, resolveRef } from '../src/content/refs';
import { accessibleName, composedParent } from '../src/content/dom';
import { runAction } from '../src/content/actions';

const opts = { snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false };
beforeEach(() => { document.body.innerHTML = ''; resetRegistry(); });

it('a removed anchor is stale and its URL host is never treated as a shadow host', () => {
  document.body.innerHTML = '<a href="https://example.test/article">Article</a>';
  const link = document.querySelector('a')!, ref = takeSnapshot(opts).elements[0]!.ref;
  link.remove();
  expect(() => resolveRef(ref)).toThrowError(expect.objectContaining({code:'STALE_ELEMENT'}));
  expect(composedParent(link)).toBeNull();
});

it('review: refuses a reused button when its row now denotes another record', () => {
  document.body.innerHTML = '<ul><li><span>A-1001</span><button>취소</button></li><li><span>B-2002</span><button>취소</button></li></ul>';
  const first = takeSnapshot(opts).elements[0]!;
  expect(first.context).toContain('A-1001');
  document.querySelector('span')!.textContent = 'C-3003';
  expect(() => resolveRef(first.ref)).toThrowError(expect.objectContaining({ code: 'STALE_ELEMENT' }));
});

it('review: aria-labelledby takes precedence over aria-label', () => {
  document.body.innerHTML = '<span id="name">주문 A-1001 취소</span><button aria-label="취소" aria-labelledby="name"></button>';
  expect(accessibleName(document.querySelector('button')!)).toBe('주문 A-1001 취소');
});

it('review: resolves an aria-labelledby inside the same open shadow root', () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = '<span id="name">검색어</span><input aria-labelledby="name">';
  expect(accessibleName(root.querySelector('input')!)).toBe('검색어');
});

it('review: refuses an aria-disabled custom button before dispatch', async () => {
  document.body.innerHTML = '<div role="button" aria-disabled="true">저장</div>';
  const ref = takeSnapshot(opts).elements[0]!.ref;
  await expect(runAction('click', {ref})).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
});

it('review: does not confirm a fill rolled back in a queued application update', async () => {
  document.body.innerHTML = '<input aria-label="이름" value="before">';
  const input = document.querySelector('input')!;
  input.addEventListener('input', () => queueMicrotask(() => {input.value = 'before';}));
  const ref = takeSnapshot(opts).elements[0]!.ref;
  const result = await runAction('fill', {ref, text:'after'});
  expect(input.value).toBe('before');
  expect(result.verified).toMatchObject({matches:false});
});

it('review: keeps row context when a query leaves a single matching control', () => {
  document.body.innerHTML = '<ul><li><span>A-1001</span><button>취소</button></li><li><span>B-2002</span><button>취소</button></li></ul>';
  const found = takeSnapshot({...opts, query:'A-1001', maxElements:1}).elements;
  expect(found).toHaveLength(1);
  expect(found[0]!.context).toContain('A-1001');
});

it('row identity survives edits to inputs and status but rejects moving the same node to another row',async()=>{
  document.body.innerHTML='<ul><li><span>A</span><input aria-label="Name"><div role="status">Pending</div><button>Save</button></li><li><span>B</span></li></ul>';
  const snapshot=takeSnapshot(opts),button=snapshot.elements.find(e=>e.name==='Save')!,input=snapshot.elements.find(e=>e.name==='Name')!;
  await runAction('fill',{ref:input.ref,text:'new'});
  document.querySelector('[role=status]')!.textContent='Working';
  expect(resolveRef(button.ref)).toBe(document.querySelector('button'));
  document.querySelectorAll('li')[1]!.append(document.querySelector('button')!);
  expect(()=>resolveRef(button.ref)).toThrowError(expect.objectContaining({code:'STALE_ELEMENT'}));
});
it('identity keeps the distinguishing suffix of a long name',()=>{
  document.body.innerHTML='<button></button>';
  const el=document.querySelector('button')!;el.textContent='Common '.repeat(20)+'A';
  const ref=takeSnapshot(opts).elements[0]!.ref;
  el.textContent='Common '.repeat(20)+'B';
  expect(()=>resolveRef(ref)).toThrowError(expect.objectContaining({code:'STALE_ELEMENT'}));
});
it('self-referenced aria-labelledby combines the short label and record name without recursion',()=>{
  document.body.innerHTML='<span id="record">A-1001</span><button id="cancel" aria-label="Cancel" aria-labelledby="cancel record"></button>';
  expect(accessibleName(document.querySelector('button')!)).toBe('Cancel A-1001');
});
it('disabled state crosses an open shadow boundary and is visible in snapshots',async()=>{
  document.body.innerHTML='<div aria-disabled="true"></div>';
  const root=document.querySelector('div')!.attachShadow({mode:'open'});root.innerHTML='<button>Save</button>';
  const el=takeSnapshot(opts).elements[0]!;
  expect(el.disabled).toBe(true);
  await expect(runAction('click',{ref:el.ref})).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
});
it('a small unmarked card also rejects reuse under a different record title',()=>{
  document.body.innerHTML='<div><span>Order A</span><button>Cancel</button></div>';
  const item=takeSnapshot(opts).elements[0]!;
  document.querySelector('span')!.textContent='Order B';
  expect(()=>resolveRef(item.ref)).toThrowError(expect.objectContaining({code:'STALE_ELEMENT'}));
});

it.each(['li','article','div','tr'].flatMap(tag=>['fill','select'].map(method=>({tag,method}))))('confirms $method while an ordinary sibling updates inside $tag',async({tag,method})=>{
    const control=method==='fill'?'<input aria-label="Field">':'<select aria-label="Field"><option value="before">Before</option><option value="after">After</option></select>';
    const contents=control+'<span>Pending</span>';
    document.body.innerHTML=tag==='tr'?`<table><tr><td>${contents}</td></tr></table>`:`<${tag}>${contents}</${tag}>`;
    resetRegistry();
    const el=document.querySelector('input,select') as HTMLInputElement|HTMLSelectElement;
    el.addEventListener(method==='fill'?'input':'change',()=>queueMicrotask(()=>{document.querySelector('span')!.textContent='Valid';}));
    const ref=takeSnapshot(opts).elements.find(e=>e.name==='Field')!.ref;
    const result=await runAction(method,{ref,...(method==='fill'?{text:'after'}:{option:'after'})});
    expect(el.value).toBe('after');expect(result.verified).toMatchObject({matches:true});
    // The old snapshot still cannot authorize another write after its record changes.
    expect(()=>resolveRef(ref)).toThrowError(expect.objectContaining({code:'STALE_ELEMENT'}));
});
it.each(['detached','renamed','moved','record-key'])('does not confirm an input whose target is %s after its handler',async(change)=>{
  document.body.innerHTML='<ul><li data-id="A"><input aria-label="Field"></li><li data-id="B"></li></ul>';
  const el=document.querySelector('input')!;
  el.addEventListener('input',()=>queueMicrotask(()=>{
    if(change==='detached')el.replaceWith(el.cloneNode());
    if(change==='renamed')el.setAttribute('aria-label','Other');
    if(change==='moved')document.querySelectorAll('li')[1]!.append(el);
    if(change==='record-key')document.querySelector('li')!.setAttribute('data-id','B');
  }));
  const ref=takeSnapshot(opts).elements[0]!.ref;
  await expect(runAction('fill',{ref,text:'after'})).rejects.toMatchObject({code:'EXECUTION_UNKNOWN',retry:'unsafe'});
});
it.each(['','x'.repeat(300)])('confirms input when sibling text changes the small-card classification (%s)',async(before)=>{
  document.body.innerHTML='<div><input aria-label="Field"><span></span></div>';
  const el=document.querySelector('input')!,message=document.querySelector('span')!;message.textContent=before;
  el.addEventListener('input',()=>queueMicrotask(()=>{message.textContent=before?'Long '.repeat(80):'Valid';}));
  const ref=takeSnapshot(opts).elements[0]!.ref;
  await expect(runAction('fill',{ref,text:'after'})).resolves.toMatchObject({verified:{matches:true,value:'after'}});
});
it.each(['pointerdown','mousedown'])('dispatches one click after %s updates ordinary sibling feedback',async(event)=>{
  document.body.innerHTML='<article><span>Idle</span><button>Submit</button></article>';
  const button=document.querySelector('button')!;let clicks=0;
  button.addEventListener(event,()=>{document.querySelector('span')!.textContent='Pressed';});
  button.addEventListener('click',()=>clicks++);
  const ref=takeSnapshot(opts).elements[0]!.ref;
  await expect(runAction('click',{ref,waitFor:{text:'Pressed'}})).resolves.toMatchObject({executed:true});
  expect(clicks).toBe(1);
  expect(()=>resolveRef(ref)).toThrowError(expect.objectContaining({code:'STALE_ELEMENT'}));
});
it('keeps a clickable pointer card when its only child control is ARIA-disabled',async()=>{
  document.body.innerHTML='<div style="cursor:pointer" aria-label="Order card"><span>Open order</span><button aria-disabled="true">Unavailable action</button></div>';
  const card=document.querySelector('div')!;let clicks=0;card.addEventListener('click',()=>clicks++);
  const snapshot=takeSnapshot(opts),item=snapshot.elements.find(e=>e.name==='Order card');
  expect(item).toBeDefined();
  expect(snapshot.elements.find(e=>e.name==='Unavailable action')?.disabled).toBe(true);
  await runAction('click',{ref:item!.ref,waitFor:{text:'Open order'}});
  expect(clicks).toBe(1);
});
