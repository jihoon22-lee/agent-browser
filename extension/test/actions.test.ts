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
  expect(calls).toEqual([{ top: 800 }]);
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
