import { takeSnapshot } from "../src/content/snapshot";
import { resetRegistry } from "../src/content/refs";
import { runAction, cancelUpTo } from "../src/content/actions";

const snap = () => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false });
const refOf = (name: string) => snap().elements.find((e) => e.name === name)!.ref;

// same tracker as tests/fixtures/site/app.js
function controlledInput(el: HTMLInputElement, onChange: (v: string) => void) {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  let tracked = el.value;
  Object.defineProperty(el, "value", { configurable: true, get() { return desc.get!.call(this); }, set(v) { tracked = String(v); desc.set!.call(this, v); } });
  el.addEventListener("input", () => { const now = desc.get!.call(el); if (now !== tracked) { tracked = now; onChange(now); } });
}

beforeEach(() => { document.body.innerHTML = ""; resetRegistry(); });
it('click supplies local viewport coordinates and button state, preserving native checkbox activation',async()=>{
  document.body.innerHTML='<label><input type="checkbox"> Mail</label>';
  const el=document.querySelector('input')!;
  vi.spyOn(el,'getBoundingClientRect').mockReturnValue({left:40,top:80,width:20,height:10,right:60,bottom:90} as DOMRect);
  const events:MouseEvent[]=[];
  for(const type of ['mousedown','mouseup','click'])el.addEventListener(type,e=>events.push(e as MouseEvent));
  await runAction('click',{ref:refOf('Mail'),generation:1});
  expect(events.map(e=>[e.type,e.clientX,e.clientY,e.buttons,e.detail,e.isTrusted])).toEqual([
    ['mousedown',50,85,1,1,false],['mouseup',50,85,0,1,false],['click',50,85,0,1,false],
  ]);
  expect(el.checked).toBe(true);
});
it('discovers explicit inline and keyboard click candidates without treating every row as interactive',()=>{
  document.body.innerHTML='<div onclick="void 0">Inline mail</div><div tabindex="0">Keyboard mail</div><div tabindex="-1">programmatic</div><div>plain</div><div onkeydown="void 0">unfocusable keyboard handler</div>';
  expect(snap().elements.map(e=>e.name)).toEqual(['Inline mail','Keyboard mail']);
});
it('clicks a real fragment of a wrapped inline link instead of whitespace in its bounding box',async()=>{
  document.body.innerHTML='<a href="/mail">Wrapped link</a>';const el=document.querySelector('a')!;
  vi.spyOn(el,'getBoundingClientRect').mockReturnValue({left:10,top:10,width:110,height:30} as DOMRect);
  vi.spyOn(el,'getClientRects').mockReturnValue([{left:10,top:10,right:30,bottom:20,width:20,height:10},{left:100,top:30,right:120,bottom:40,width:20,height:10}] as unknown as DOMRectList);
  let point:number[]=[];el.addEventListener('click',e=>{e.preventDefault();point=[e.clientX,e.clientY];});
  await runAction('click',{ref:refOf('Wrapped link'),generation:1});
  expect(point).toEqual([20,15]);
});

it("fill updates React-like controlled state, not just the DOM", async () => {
  document.body.innerHTML = `<label for="n">이름</label><input id="n">`;
  const app = { name: "" };
  controlledInput(document.getElementById("n") as HTMLInputElement, (v) => { app.name = v; });
  const r = await runAction("fill", { ref: refOf("이름"), text: "홍길동", generation: 1 });
  expect(r).toMatchObject({ executed: true, verified: { value: "홍길동", matches: true } });
  expect(app.name).toBe("홍길동");
});

it("click on a detached element is STALE_ELEMENT and never clicks a look-alike", async () => {
  document.body.innerHTML = `<button id="a">확인</button>`;
  const ref = refOf("확인");
  let clicks = 0;
  document.body.innerHTML = `<button id="b">확인</button>`;
  document.getElementById("b")!.addEventListener("click", () => clicks++);
  await expect(runAction("click", { ref, generation: 1 })).rejects.toMatchObject({ code: "STALE_ELEMENT" });
  expect(clicks).toBe(0);
});

it("click on disabled button is not interactable", async () => {
  document.body.innerHTML = `<button disabled>저장</button>`;
  await expect(runAction("click", { ref: refOf("저장"), generation: 1 })).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
});

it("select by visible label and checkbox state", async () => {
  document.body.innerHTML = `<label for="s">크기</label><select id="s"><option value="s">작게</option><option value="l">크게</option></select>
    <label><input type="checkbox" id="c"> 동의</label>`;
  let changed = "";
  document.getElementById("s")!.addEventListener("change", (e) => { changed = (e.target as HTMLSelectElement).value; });
  expect(await runAction("select", { ref: refOf("크기"), option: "크게", generation: 1 })).toMatchObject({ verified: { value: "l" } });
  expect(changed).toBe("l");
  expect(await runAction("select", { ref: refOf("동의"), checked: true, generation: 1 })).toMatchObject({ verified: { checked: true } });
  await expect(runAction("select", { ref: refOf("크기"), option: "없는값", generation: 1 })).rejects.toMatchObject({ code: "ELEMENT_NOT_FOUND" });
});

it("Enter in a form field submits the form once", async () => {
  document.body.innerHTML = `<form><label for="q">검색어</label><input id="q"></form>`;
  let submits = 0;
  document.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  const r = await runAction("press", { ref: refOf("검색어"), key: "Enter", generation: 1 });
  expect(submits).toBe(1);
  expect(r).toMatchObject({ verified: { submitted: true } });
});

it("wait resolves when text appears and times out with TIMEOUT", async () => {
  document.body.innerHTML = `<div id="slot"></div>`;
  setTimeout(() => { document.getElementById("slot")!.textContent = "로딩 완료"; }, 300);
  expect(await runAction("wait", { text: "로딩 완료", timeoutMs: 2000, generation: 1 })).toMatchObject({ verified: { met: "text" } });
  await expect(runAction("wait", { text: "절대 안 나옴", timeoutMs: 300, generation: 1 })).rejects.toMatchObject({ code: "TIMEOUT" });
  await expect(runAction("wait", { timeoutMs: 300, generation: 1 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
});

it("fill never reports a password value back", async () => {
  document.body.innerHTML = `<label for="p">비밀번호</label><input id="p" type="password">`;
  const r = await runAction("fill", { ref: refOf("비밀번호"), text: "hunter2", generation: 1 });
  expect(r).toMatchObject({ executed: true, verified: { matches: true } });
  expect(JSON.stringify(r)).not.toContain("hunter2");
});

it("fill rejects elements that cannot take text", async () => {
  document.body.innerHTML = `<button>저장</button>`;
  await expect(runAction("fill", { ref: refOf("저장"), text: "x", generation: 1 })).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
});

it("click reports whether the page changed", async () => {
  document.body.innerHTML = `<button id="b">추가</button><div id="out"></div>`;
  document.getElementById("b")!.addEventListener("click", () => { document.getElementById("out")!.textContent = "추가됨"; });
  const r = await runAction("click", { ref: refOf("추가"), generation: 1 });
  expect(r).toMatchObject({ executed: true, verified: { domChanged: true, urlChanged: false } });
});

it("commands from a cancelled generation do not run", async () => {
  document.body.innerHTML = `<button>확인</button>`;
  let clicks = 0;
  document.querySelector("button")!.addEventListener("click", () => clicks++);
  const ref = refOf("확인");
  cancelUpTo(5);
  await expect(runAction("click", { ref, generation: 5 })).rejects.toMatchObject({ code: "CANCELLED" });
  expect(clicks).toBe(0);
});

// generation 10: the cancel test above leaves generations up to 5 cancelled in this module
it("scroll moves the page and rejects unknown directions", async () => {
  document.body.innerHTML = `<p>본문</p>`;
  const el = document.documentElement; // jsdom has no document.scrollingElement; the action falls back to this
  const calls: Array<{ top?: number }> = [];
  // jsdom has no scrolling; record what the action asks for
  (el as unknown as { scrollBy: (o: { top?: number }) => void }).scrollBy = (o) => { calls.push(o); };
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 1000 });
  const r = await runAction("scroll", { direction: "down", generation: 10 });
  expect(r).toMatchObject({ executed: true });
  expect(calls).toEqual([{ top: 800, behavior: 'instant' }]);
  await expect(runAction("scroll", { direction: "sideways", generation: 10 })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
});

it.each(['<option disabled value="bad">Blocked</option>', '<optgroup disabled><option value="bad">Blocked</option></optgroup>'])('R08 refuses an unavailable option before value or events change: %s', async markup => {
  document.body.innerHTML = `<select aria-label="Choice"><option value="good">Good</option>${markup}</select>`;
  const select = document.querySelector('select')!, changed = vi.fn();
  select.addEventListener('input', changed); select.addEventListener('change', changed);
  await expect(runAction('select', {ref: refOf('Choice'), option: 'bad', generation: 10})).rejects.toMatchObject({code: 'ELEMENT_NOT_INTERACTABLE'});
  expect(select.value).toBe('good'); expect(changed).not.toHaveBeenCalled();
});

it('close preflight accepts a clean implicit select but rejects edited shadow controls', async () => {
  document.body.innerHTML='<select><option>One</option><option>Two</option></select><div id="host"></div>';
  await expect(runAction('close-check',{})).resolves.toEqual({executed:false});
  document.querySelector('select')!.selectedIndex=1;
  await expect(runAction('close-check',{})).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
  document.querySelector('select')!.selectedIndex=0;
  const shadow=document.querySelector('#host')!.attachShadow({mode:'open'});
  shadow.innerHTML='<input value="before">';shadow.querySelector('input')!.value='unsaved';
  await expect(runAction('close-check',{})).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
});

it('review: pointer handlers cannot retarget a previously validated link before click', async () => {
  document.body.innerHTML='<a href="/post/1">Post</a>';
  const link=document.querySelector('a')!, ref=refOf('Post'), clicked=vi.fn();
  link.addEventListener('mousedown',()=>{link.href='/post/2';});
  link.addEventListener('click',e=>{e.preventDefault();clicked();});
  await expect(runAction('click',{ref})).rejects.toMatchObject({code:'EXECUTION_UNKNOWN',retry:'unsafe'});
  expect(clicked).not.toHaveBeenCalled();
});

it('file upload is explicitly unsupported and never treats a local path as a text value',async()=>{
 document.body.innerHTML='<input type="file" aria-label="Upload">';
 await expect(runAction('fill',{ref:refOf('Upload'),text:'/synthetic/file.txt'})).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
 expect(document.querySelector('input')!.files).toHaveLength(0);
});

it.each(['checkbox','radio','range','color','number','date'])('F4 accepts untouched %s and preserves an edited value', async type => {
  document.body.innerHTML=`<input type="${type}">`;
  const el=document.querySelector('input')!;
  await expect(runAction('close-check',{})).resolves.toEqual({executed:false});
  if (type==='checkbox'||type==='radio') el.checked=true;
  else el.value=type==='color'?'#abcdef':type==='date'?'2026-10-12':'75';
  await expect(runAction('close-check',{})).rejects.toMatchObject({code:'ELEMENT_NOT_INTERACTABLE'});
});
it.each(['<input type="range" min="20" max="40" value="100">','<input type="color" value="invalid">','<input type="number" value="invalid">','<input type="date" value="invalid">'])('F4 normalizes the authored default: %s',async html=>{
  document.body.innerHTML=html;
  await expect(runAction('close-check',{})).resolves.toEqual({executed:false});
});
it.each(['','aria-label="Composer"'])('F8 keeps an editable ref through repeated fill and click (%s)',async attrs=>{
  document.body.innerHTML=`<div contenteditable="true" role="textbox" ${attrs}>old</div>`;
  const el=document.querySelector('div')!;
  Object.defineProperty(el,'isContentEditable',{get:()=>true});
  const ref=refOf(attrs?'Composer':'old');
  await runAction('fill',{ref,text:'hello'});
  await runAction('fill',{ref,text:'hello again'});
  expect(el.textContent).toBe('hello again');
  await expect(runAction('click',{ref})).resolves.toMatchObject({executed:true});
});
it('F8 still rejects renamed noneditable buttons',async()=>{
  document.body.innerHTML='<button>Before</button>';
  const ref=refOf('Before');document.querySelector('button')!.textContent='After';
  await expect(runAction('click',{ref})).rejects.toMatchObject({code:'STALE_ELEMENT'});
});
it.each(['hidden','renamed','removed'])('F11 reports unsafe execution after mousedown (%s)',async change=>{
  document.body.innerHTML='<button>Menu</button><div id="overlay" hidden>Open</div>';
  const el=document.querySelector('button')!, ref=refOf('Menu'), click=vi.fn();
  el.addEventListener('click',click);
  el.addEventListener('mousedown',()=>{
    document.getElementById('overlay')!.hidden=false;
    if(change==='hidden')el.hidden=true;else if(change==='renamed')el.textContent='Changed';else el.remove();
  });
  await expect(runAction('click',{ref})).rejects.toMatchObject({code:'EXECUTION_UNKNOWN',retry:'unsafe'});
  expect(document.getElementById('overlay')!.hidden).toBe(false);
  expect(click).not.toHaveBeenCalled();
});
it('review R6 preserves textarea refs across fill but rejects a recycled authored default',async()=>{
  document.body.innerHTML='<textarea>First record</textarea>';
  const el=document.querySelector('textarea')!,ref=snap().elements[0]!.ref;
  await runAction('fill',{ref,text:'edited once'});await runAction('fill',{ref,text:'edited twice'});
  el.defaultValue='Second record';el.value='Second record';
  await expect(runAction('fill',{ref,text:'wrong record'})).rejects.toMatchObject({code:'STALE_ELEMENT'});
  expect(el.value).toBe('Second record');
});

it("clicks a visually hidden checkbox through its own styled label", async () => {
  document.body.innerHTML = `<label id="l"><input type="checkbox" id="c"><span>약관 동의</span></label>`;
  const input = document.getElementById("c") as HTMLInputElement, label = document.getElementById("l")!;
  const ref = refOf("약관 동의");
  vi.spyOn(document.documentElement, "getClientRects").mockReturnValue([{ width: 800, height: 600 }] as unknown as DOMRectList);
  vi.spyOn(input, "getClientRects").mockReturnValue([{ left: 10, top: 10, right: 20, bottom: 20, width: 10, height: 10 }] as unknown as DOMRectList);
  input.scrollIntoView = vi.fn();
  (document as any).elementFromPoint = vi.fn(() => label.querySelector("span"));
  try {
    await runAction("click", { ref, generation: 10 });
    expect(input.checked).toBe(true);
    expect(input.scrollIntoView).not.toHaveBeenCalled(); // Its label is already reachable.
  } finally { delete (document as any).elementFromPoint; vi.restoreAllMocks(); }
});

it("uses another visible point when the center of a control is covered", async () => {
  document.body.innerHTML = `<button id="b">결제</button><div id="badge">1</div>`;
  const button = document.getElementById("b")!, badge = document.getElementById("badge")!;
  const ref = refOf("결제");
  vi.spyOn(document.documentElement, "getClientRects").mockReturnValue([{ width: 800, height: 600 }] as unknown as DOMRectList);
  vi.spyOn(button, "getClientRects").mockReturnValue([{ left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }] as unknown as DOMRectList);
  button.scrollIntoView = vi.fn();
  (document as any).elementFromPoint = vi.fn((x: number) => (x === 50 ? badge : button));
  let clicked: number[] = [];
  button.addEventListener("click", e => { clicked = [e.clientX, e.clientY]; });
  try {
    await runAction("click", { ref, generation: 10 });
    expect(clicked).toEqual([25, 20]);
  } finally { delete (document as any).elementFromPoint; vi.restoreAllMocks(); }
});

it("fills rich editors through insertText so their own state updates", async () => {
  document.body.innerHTML = `<div contenteditable="true" aria-label="본문">이전</div>`;
  const editor = document.querySelector("div")!;
  Object.defineProperty(editor, "isContentEditable", { get: () => true });
  const exec = vi.fn((_command: string, _ui: boolean, value: string) => { editor.textContent = value; return true; });
  (document as any).execCommand = exec;
  try {
    const result = await runAction("fill", { ref: refOf("본문"), text: "새 내용", generation: 10 });
    expect(exec).toHaveBeenCalledWith("insertText", false, "새 내용");
    expect(result).toMatchObject({ verified: { method: "insertText", matches: true } });
  } finally { delete (document as any).execCommand; }
});

it("refuses to fill buttons and checkboxes", async () => {
  document.body.innerHTML = `<input type="submit" value="보내기"><input type="checkbox" aria-label="동의">`;
  await expect(runAction("fill", { ref: refOf("보내기"), text: "x", generation: 10 })).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
  await expect(runAction("fill", { ref: refOf("동의"), text: "x", generation: 10 })).rejects.toMatchObject({ code: "ELEMENT_NOT_INTERACTABLE" });
  expect((document.querySelector("input[type=submit]") as HTMLInputElement).value).toBe("보내기");
});

it("outlines the click target while the click is observed, outside snapshots and hit testing", async () => {
  document.body.innerHTML = '<button>표시 확인</button>';
  const button = document.querySelector('button')!;
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
  let during: HTMLElement | null = null;
  button.addEventListener('click', () => { during = document.getElementById('agent-browser-target'); });
  const result = await runAction('click', { ref: refOf('표시 확인'), generation: 10 });
  expect(during).not.toBeNull();
  expect(during!.style.pointerEvents).toBe('none');
  expect(during!.shadowRoot).toBeNull();
  expect((result as any).verified.domChanged).toBe(false);
  await Promise.resolve();
  expect(document.getElementById('agent-browser-target')).toBeNull();
  expect(snap().elements.map(e => e.name)).toEqual(['표시 확인']);
});

describe("trusted input", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("lets the debugger click instead of synthetic events when trusted input answers", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    document.body.innerHTML = '<button>신뢰</button>';
    const button = document.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result: any = await runAction('click', { ref: refOf('신뢰'), generation: 10, requestId: 'r-1', trusted: true });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'trusted-input', requestId: 'r-1', action: 'click' }));
    expect(clicks).not.toHaveBeenCalled();
    expect(result.verified.trusted).toBe(true);
  });
  it("falls back to synthetic events and says why when trusted input is refused", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ ok: false, reason: 'canceled_by_user' })) } });
    document.body.innerHTML = '<button>대체</button>';
    const button = document.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    const result: any = await runAction('click', { ref: refOf('대체'), generation: 10, requestId: 'r-2', trusted: true });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(result.verified).toMatchObject({ trusted: false, trustedReason: 'canceled_by_user' });
  });
  it("sends a key as trusted input and reports the observed change", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    document.body.innerHTML = '<input aria-label="검색">';
    const result: any = await runAction('press', { ref: refOf('검색'), key: 'Enter', generation: 10, requestId: 'r-3', trusted: true });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'trusted-input', action: 'key', key: 'Enter', requestId: 'r-3' }));
    expect(result.verified).toMatchObject({ key: 'Enter', trusted: true, urlChanged: false });
  });
});

describe("trusted input keeps the keyboard and click safety checks", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("refuses a key on an element that cannot take focus before sending anything", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    document.body.innerHTML = '<button>삭제</button><div role="button">보기</div>';
    document.querySelector('button')!.focus();
    await expect(runAction('press', { ref: refOf('보기'), key: 'Enter', generation: 10, requestId: 'k-1', trusted: true })).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("refuses keyboard editing of a rich editor the same way", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    document.body.innerHTML = '<div contenteditable="true" aria-label="본문">글</div>';
    await expect(runAction('press', { ref: refOf('본문'), key: 'Enter', generation: 10, requestId: 'k-2', trusted: true })).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("never repeats a click that was partly delivered as trusted input", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ ok: false, reason: 'debugger-error', dispatched: true })) } });
    document.body.innerHTML = '<button>한 번만</button>';
    const button = document.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
    const clicks = vi.fn(); button.addEventListener('click', clicks);
    await expect(runAction('click', { ref: refOf('한 번만'), generation: 10, requestId: 'c-1', trusted: true })).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    expect(clicks).not.toHaveBeenCalled();
  });
});

describe("pointer modes", () => {
  it("hover moves over the element without pressing or clicking it", async () => {
    document.body.innerHTML = '<a href="#go">메뉴</a>';
    const link = document.querySelector('a')!;
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
    const seen: string[] = []; for (const t of ['mouseover', 'mouseenter', 'mousemove', 'mousedown', 'click']) link.addEventListener(t, () => seen.push(t));
    const result: any = await runAction('click', { ref: refOf('메뉴'), mode: 'hover', generation: 10 });
    expect(seen).toEqual(['mouseover', 'mouseenter', 'mousemove']);
    expect(result.verified.mode).toBe('hover');
  });
  it("hover enters the element's ancestors too, outermost first, as a real pointer would", async () => {
    document.body.innerHTML = '<nav><div id="menu"><a href="#go">메뉴</a></div></nav>';
    const link = document.querySelector('a')!;
    vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
    const entered: string[] = [];
    for (const el of [document.querySelector('nav')!, document.querySelector('#menu')!, link]) el.addEventListener('mouseenter', e => { if (e.target === el) entered.push(el.tagName); });
    await runAction('click', { ref: refOf('메뉴'), mode: 'hover', generation: 10 });
    expect(entered).toEqual(['NAV', 'DIV', 'A']);
  });
  it("double and right clicks send their own event sequences", async () => {
    document.body.innerHTML = '<div role="button" tabindex="0">항목</div>';
    const el = document.querySelector('div')!;
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 80, height: 20, right: 90, bottom: 30 } as DOMRect);
    const seen: string[] = []; for (const t of ['click', 'dblclick', 'contextmenu']) el.addEventListener(t, () => seen.push(t));
    await runAction('click', { ref: refOf('항목'), mode: 'double', generation: 10 });
    expect(seen).toEqual(['click', 'click', 'dblclick']);
    seen.length = 0;
    await runAction('click', { ref: refOf('항목'), mode: 'right', generation: 10 });
    expect(seen).toEqual(['contextmenu']);
  });
});

describe("drag", () => {
  const box = (el: Element, left: number) => vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left, top: 10, width: 80, height: 20, right: left + 80, bottom: 30 } as DOMRect);
  it("drag delivers pointer moves and an HTML5 drop on the target", async () => {
    document.body.innerHTML = '<div draggable="true">카드</div><div role="listitem" tabindex="0">완료</div>';
    const [card, done] = [...document.querySelectorAll('div')];
    box(card!, 10); box(done!, 200);
    const seen: string[] = []; for (const t of ['mousedown', 'dragstart']) card!.addEventListener(t, () => seen.push('card:' + t));
    for (const t of ['mouseup', 'drop']) done!.addEventListener(t, e => { e.preventDefault(); seen.push('done:' + t); });
    done!.addEventListener('dragover', e => e.preventDefault());
    const result: any = await runAction('click', { ref: refOf('카드'), toRef: refOf('완료'), mode: 'drag', generation: 10 });
    expect(seen).toEqual(['card:mousedown', 'done:mouseup', 'card:dragstart', 'done:drop']);
    expect(result.verified.mode).toBe('drag');
  });
  it("a plain element gets pointer events but no HTML5 drag", async () => {
    document.body.innerHTML = '<div tabindex="0">손잡이</div><div tabindex="0">자리</div>';
    const [handle, slot] = [...document.querySelectorAll('div')];
    box(handle!, 10); box(slot!, 200);
    const moves: number[] = []; document.addEventListener('mousemove', e => moves.push((e as MouseEvent).clientX));
    const drags = vi.fn(); handle!.addEventListener('dragstart', drags);
    await runAction('click', { ref: refOf('손잡이'), toRef: refOf('자리'), mode: 'drag', generation: 10 });
    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(moves.at(-1)).toBe(240);
    expect(drags).not.toHaveBeenCalled();
  });
  it("drag from a link inside a draggable card starts the card's HTML5 drag and reports the drop", async () => {
    document.body.innerHTML = '<ul><li draggable="true"><a href="#x">제목</a></li></ul><div role="region" aria-label="놓을 곳" tabindex="0">여기</div>';
    const [link, zone] = [document.querySelector('a')!, document.querySelector('[role=region]')!];
    box(link, 10); box(zone, 200);
    const starts: Element[] = []; document.addEventListener('dragstart', e => starts.push(e.target as Element));
    zone.addEventListener('dragover', e => e.preventDefault()); zone.addEventListener('drop', e => e.preventDefault());
    const result: any = await runAction('click', { ref: refOf('제목'), toRef: refOf('놓을 곳'), mode: 'drag', generation: 10 });
    expect(starts).toEqual([document.querySelector('li')]);
    expect(result.verified.dropped).toBe(true);
  });
  it("a refused drop is reported as not dropped", async () => {
    document.body.innerHTML = '<div draggable="true">카드</div><div tabindex="0">완료</div>';
    const [card, done] = [...document.querySelectorAll('div')];
    box(card!, 10); box(done!, 200);
    const result: any = await runAction('click', { ref: refOf('카드'), toRef: refOf('완료'), mode: 'drag', generation: 10 });
    expect(result.verified.dropped).toBe(false);
  });
  it("drag refuses a stale target ref", async () => {
    document.body.innerHTML = '<div draggable="true">카드</div><div tabindex="0">완료</div>';
    const card = refOf('카드'), target = refOf('완료');
    document.querySelectorAll('div')[1]!.remove();
    await expect(runAction('click', { ref: card, toRef: target, mode: 'drag', generation: 10 })).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
  });
});

describe("upload", () => {
  // jsdom has no DataTransfer and only takes a real FileList; stand in for both.
  beforeEach(() => {
    vi.stubGlobal('DataTransfer', class { list: File[] = []; items = { add: (f: File) => { this.list.push(f); } }; get files() { return this.list as unknown as FileList; } });
  });
  afterEach(() => vi.unstubAllGlobals());
  const filesOf = (input: HTMLInputElement) => { let value: unknown = []; Object.defineProperty(input, 'files', { configurable: true, get: () => value, set: v => { value = v; } }); return () => value as File[]; };
  const png = { name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw==' };
  it("puts the attachment into the file input behind a label and fires change", async () => {
    document.body.innerHTML = '<label for="f">파일 선택</label><input id="f" type="file" accept="image/*" hidden>';
    const input = document.querySelector('input')!, files = filesOf(input), changed = vi.fn(); input.addEventListener('change', changed);
    const result: any = await runAction('upload', { ref: refOf('파일 선택'), ...png, generation: 10 });
    expect(files().map(f => f.name)).toEqual(['a.png']);
    expect(files()[0]!.type).toBe('image/png');
    expect(files()[0]!.size).toBe(4);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(result.verified).toMatchObject({ files: ['a.png'], size: 4 });
  });
  it("upload reports a page change made by the input's change handler", async () => {
    document.body.innerHTML = '<label for="f">파일 선택</label><input id="f" type="file" hidden><div id="preview"></div>';
    const input = document.querySelector('input')!; filesOf(input);
    input.addEventListener('change', () => { document.getElementById('preview')!.textContent = '미리보기 a.png'; });
    const result: any = await runAction('upload', { ref: refOf('파일 선택'), ...png, generation: 10 });
    expect(result.verified.domChanged).toBe(true);
  });
  it("refuses a file the input does not accept and leaves it empty", async () => {
    document.body.innerHTML = '<label for="f">파일 선택</label><input id="f" type="file" accept="image/*,.gif" hidden>';
    const input = document.querySelector('input')!, files = filesOf(input);
    await expect(runAction('upload', { ref: refOf('파일 선택'), name: 'a.pdf', mime: 'application/pdf', dataUrl: 'data:application/pdf;base64,AAAA', generation: 10 })).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
    expect(files()).toEqual([]);
  });
  it("finds the one file input of a button's form, but not when there are two", async () => {
    document.body.innerHTML = '<form><input type="file" hidden><button type="button">올리기</button></form><form><input type="file" hidden><input type="file" hidden><button type="button">둘</button></form>';
    const [one] = [...document.querySelectorAll('input')], files = filesOf(one!);
    await runAction('upload', { ref: refOf('올리기'), ...png, generation: 10 });
    expect(files().map(f => f.name)).toEqual(['a.png']);
    await expect(runAction('upload', { ref: refOf('둘'), ...png, generation: 10 })).rejects.toMatchObject({ code: 'ELEMENT_NOT_INTERACTABLE' });
  });
});
