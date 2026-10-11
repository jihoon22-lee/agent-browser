import { test, expect, type Page } from "@playwright/test";
import { startWorld, type World } from "./harness";

type ElementRef = { ref: string; name: string; role: string; [key: string]: unknown };
type Snapshot = { url: string; title: string; snapshotId: number; frames: Array<{ frameId: number; url: string; text: { content: string }; elements: ElementRef[] }>; frameErrors: Array<{ frameId: number; code: string }> };
let world: World;

const elements = (snapshot: Snapshot) => snapshot.frames.flatMap((frame) => frame.elements);
function ref(snapshot: Snapshot, name: string, role?: string) {
  const matches = elements(snapshot).filter((element) => element.name === name && (!role || element.role === role));
  expect(matches, `unique element ${name} ${role ?? ""}`).toHaveLength(1);
  return matches[0].ref;
}
async function snapshot(operationId: string): Promise<Snapshot> {
  return (await world.ok("browser_snapshot", { operationId })).data;
}
async function setup(path: string): Promise<{ page: Page; operationId: string; snap: Snapshot }> {
  const page = await world.open(path);
  const operationId = await world.attach(page);
  return { page, operationId, snap: await snapshot(operationId) };
}

test.beforeAll(async ({}, testInfo) => {
  world = await startWorld();
  await testInfo.attach("runtime", { body: JSON.stringify(world.runtime, null, 2), contentType: "application/json" });
  console.log(`E2E runtime: ${JSON.stringify(world.runtime)}`);
});
test.beforeEach(async () => { await fetch(`${world.fixture.base}/__reset`, { method: "POST" }); });
test.afterEach(async () => {
  world.relay.clearHolds();
  const status = await world.admin("status.get");
  if (status.operation) await world.mcp.call("browser_tabs", { action: "release", operationId: status.operation.id });
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
  expect(world.mcp.invalidStdout).toEqual([]);
});
test.afterAll(async () => { await world?.stop(); });

test("S01 list tabs and attach a specific tab", async () => {
  const page = await world.open("search.html");
  const id = await world.tabId(page);
  const listed = await world.ok("browser_tabs", { action: "list" });
  expect(listed.data.tabs).toEqual(expect.arrayContaining([expect.objectContaining({ tabId: id, url: page.url(), attachable: true })]));
  expect(await world.attach(page)).toMatch(/^op-/);
});

test("S02 search via fill + Enter and verify results", async () => {
  const { operationId, snap } = await setup("search.html");
  const input = ref(snap, "검색어");
  await world.ok("browser_fill", { operationId, ref: input, text: "브라우저" });
  await world.ok("browser_press", { operationId, ref: input, key: "Enter" });
  await world.ok("browser_wait", { operationId, text: "결과 1", timeoutMs: 5_000 });
  expect((await world.log()).events).toEqual([expect.objectContaining({ type: "search", body: { q: "브라우저", category: "전체" } })]);
});

test("S03 select, checkbox, text field values", async () => {
  const { page, operationId, snap } = await setup("form.html");
  await world.ok("browser_fill", { operationId, ref: ref(snap, "이름"), text: "홍길동" });
  await world.ok("browser_select", { operationId, ref: ref(snap, "크기"), option: "크게" });
  await world.ok("browser_click", { operationId, ref: ref(snap, "약관 동의") });
  await world.ok("browser_click", { operationId, ref: ref(snap, "저장") });
  const data = { name: "홍길동", agree: true, size: "l" };
  const extracted = await world.ok("browser_extract", { operationId, kind: "text" });
  expect(extracted.data.text.content).toContain(JSON.stringify(data));
  expect(await page.evaluate(() => (window as any).__app)).toEqual(data);
});

test("S04 new tab, switch, return", async () => {
  const { page, operationId } = await setup("search.html");
  const original = await world.tabId(page);
  const created = await world.ok("browser_tabs", { action: "new", operationId, url: `${world.fixture.base}/detail.html?id=1` });
  expect(created.executed).toBe("yes");
  const detail = await snapshot(operationId);
  expect(detail.frames[0].text.content).toContain("상세 1");
  await world.ok("browser_tabs", { action: "switch", operationId, tabId: original });
  expect((await snapshot(operationId)).url).toBe(page.url());
});

test("S05 SPA rerender makes old ref STALE", async () => {
  const { page, operationId, snap } = await setup("spa.html");
  const old = ref(snap, "확인");
  await world.ok("browser_click", { operationId, ref: ref(snap, "다음 화면") });
  expect((await world.mcp.call("browser_click", { operationId, ref: old })).error?.code).toBe("STALE_ELEMENT");
  expect(await page.title()).toBe("SPA");
  await world.ok("browser_click", { operationId, ref: ref(await snapshot(operationId), "확인") });
  expect(await page.title()).toBe("SPA 확인됨");
});

test("S06 async wait and timeout", async () => {
  const { operationId, snap } = await setup("async.html");
  await world.ok("browser_click", { operationId, ref: ref(snap, "불러오기") });
  await world.ok("browser_wait", { operationId, text: "로딩 완료", timeoutMs: 5_000 });
  const timed = await world.mcp.call("browser_wait", { operationId, text: "없음", timeoutMs: 500 });
  expect(timed.error?.code).toBe("TIMEOUT");
});

test("S07 iframe and open shadow DOM coverage", async () => {
  const { page, operationId, snap } = await setup(`frames.html?alt=${world.fixture.alt}`);
  const childFrames = snap.frames.filter((frame) => frame.elements.some((element) => element.name === "프레임 버튼"));
  expect(childFrames).toHaveLength(2);
  expect(new Set(childFrames.map((frame) => frame.frameId)).size).toBe(2);
  const cross = childFrames.find((frame) => new URL(frame.url).hostname === "localhost")!;
  expect(cross).toBeDefined();
  await world.ok("browser_click", { operationId, ref: cross.elements.find((element) => element.name === "프레임 버튼")!.ref });
  await expect(page.frameLocator("#cross").getByRole("button", { name: "눌림" })).toBeVisible();
  // Chromium 156.0.8078.4 permits extension isolated-world injection in this sandboxed srcdoc frame.
  expect(elements(snap).some((element) => element.name === "샌드박스 버튼")).toBe(true);
  await world.ok("browser_navigate", { operationId, url: `${world.fixture.base}/shadow.html` });
  const shadow = await snapshot(operationId);
  expect(elements(shadow).some((element) => element.name === "닫힌 버튼")).toBe(false);
  await world.ok("browser_click", { operationId, ref: ref(shadow, "그림자 버튼") });
  await expect(page.locator("#out")).toHaveText("그림자 눌림");
});

test("S08 table extraction exact cells", async () => {
  const { operationId } = await setup("detail.html?id=1");
  const extracted = await world.ok("browser_extract", { operationId, kind: "table" });
  expect(extracted.data.header).toEqual(["항목", "값"]);
  expect(extracted.data.rows).toEqual([["이름", "에이전트 브라우저"], ["가격", "12,000원"], ["비고", "a | b, c"]]);
});

test("S09 user switches tab, operation target stays", async () => {
  const { page, operationId } = await setup("search.html");
  const other = await world.open("form.html");
  await other.bringToFront();
  const snap = await snapshot(operationId);
  expect(snap.url).toBe(page.url());
  await world.ok("browser_fill", { operationId, ref: ref(snap, "검색어"), text: "고정된 탭" });
  await expect(page.locator("#q")).toHaveValue("고정된 탭");
  await expect(other.locator("#name")).toHaveValue("");
});

test("S10 screenshot never returns another tab", async () => {
  const { page, operationId } = await setup("search.html");
  await (await world.open("form.html")).bringToFront();
  expect((await world.mcp.call("browser_screenshot", { operationId })).error?.code).toBe("NEEDS_TAB_ACTIVATION");
  await page.bringToFront();
  const result = await world.mcp.callRaw("browser_screenshot", { operationId });
  expect(result.isError).not.toBe(true);
  const image = result.content.find((part) => part.type === "image");
  expect(image?.mimeType).toBe("image/png");
  expect([...Buffer.from(image!.data!, "base64").subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
});

test("S11 stop blocks queued commands", async () => {
  const { page, operationId, snap } = await setup("submit-once.html");
  const dispatched = world.relay.nextCommand("browser.wait");
  const waiting = world.mcp.call("browser_wait", { operationId, text: "없음", timeoutMs: 10_000 });
  await dispatched;
  const start = Date.now();
  expect((await world.admin("operation.abort", { operationId })).aborted).toBe(true);
  expect((await waiting).error?.code).toBe("CANCELLED");
  expect(Date.now() - start).toBeLessThan(2_000);
  expect((await world.mcp.call("browser_click", { operationId, ref: ref(snap, "제출") })).error?.code).toBe("CANCELLED");
  expect((await world.log()).submitCounts).toEqual({});
  await expect(page.locator("#state")).toHaveText("대기");
});

test("S12 bridge restart and extension reconnect", async () => {
  const page = await world.open("search.html");
  await world.attach(page);
  await world.restartBridge();
  const operationId = await world.attach(page);
  expect((await snapshot(operationId)).url).toBe(page.url());
  await world.restartWorker();
  expect((await snapshot(operationId)).url).toBe(page.url());
});

test("S13 no duplicate submit after disconnect", async () => {
  const { page, operationId, snap } = await setup("submit-once.html");
  world.relay.holdReplies("browser.click");
  const dispatched = world.relay.nextCommand("browser.click");
  const clicking = world.mcp.call("browser_click", { operationId, ref: ref(snap, "제출") });
  const command = await dispatched;
  await expect.poll(async () => Object.values((await world.log()).submitCounts)).toEqual([1]);
  await world.relay.waitHeld(command.id!);
  // The HTTP submit is recorded and its browser-command response cannot reach serve.
  await world.killBridge();
  expect((await clicking).error?.code).toBe("EXECUTION_UNKNOWN");
  await world.restartBridge();
  const recovered = await world.attach(page);
  expect((await snapshot(recovered)).url).toBe(page.url());
  await world.restartWorker();
  const replayed = await world.relay.replay(command);
  expect(replayed.ok).toBe(true); // Cache survives both bridge and actual worker restart.
  expect(Object.values((await world.log()).submitCounts)).toEqual([1]);
});

test("S14 two MCP clients conflict", async () => {
  const page = await world.open("search.html");
  const operationId = await world.attach(page);
  const second = await world.newMcp();
  expect((await second.call("browser_tabs", { action: "attach", tabId: await world.tabId(page) })).error?.code).toBe("BROWSER_BUSY");
  await world.ok("browser_tabs", { action: "release", operationId });
  expect(await world.attach(page, second)).toMatch(/^op-/);
  await second.stop();
});

test("S15 works with side panel closed", async () => {
  const panel = await world.context.newPage();
  await panel.goto(`chrome-extension://${world.extensionId}/${world.manifest.side_panel.default_path}`);
  await expect(panel.getByText("AgentBrowser", { exact: true })).toBeVisible();
  await panel.close();
  const { page, operationId } = await setup("search.html");
  expect((await snapshot(operationId)).url).toBe(page.url());
});

test("S16 mcp stdout purity", async () => {
  const list = await world.mcp.request("tools/list");
  expect(list.tools).toHaveLength(11);
  await world.ok("browser_tabs", { action: "list" });
  expect(world.mcp.stdout.length).toBeGreaterThan(2);
  expect(world.mcp.invalidStdout).toEqual([]);
  expect(world.mcp.stdout.every((message: any) => message.jsonrpc === "2.0")).toBe(true);
});

test("S17 unsupported page", async () => {
  const page = await world.context.newPage();
  await page.goto("chrome://version");
  expect((await world.mcp.call("browser_tabs", { action: "attach", tabId: await world.tabId(page) })).error?.code).toBe("UNSUPPORTED_PAGE");
});

test("R18 cancelled operation does not poison a new operation after bridge restart", async () => {
  const { page, operationId } = await setup("search.html");
  await world.admin("operation.abort", { operationId });
  await world.restartBridge();
  const newOperation = await world.attach(page);
  const snap = await snapshot(newOperation);
  await world.ok("browser_fill", { operationId: newOperation, ref: ref(snap, "검색어"), text: "새 작업" });
  await expect(page.locator("#q")).toHaveValue("새 작업");
});

test("R19 element references cannot cross tabs or navigated documents", async () => {
  const { page, operationId, snap } = await setup("search.html");
  const old = ref(snap, "검색어");
  const firstTab = await world.tabId(page);
  await world.ok("browser_tabs", { action: "new", operationId, url: `${world.fixture.base}/form.html` });
  const second = await snapshot(operationId);
  expect(ref(second, "이름")).not.toBe(old);
  expect((await world.mcp.call("browser_fill", { operationId, ref: old, text: "wrong tab" })).error?.code).toBe("STALE_ELEMENT");
  await world.ok("browser_tabs", { action: "switch", operationId, tabId: firstTab });
  await world.ok("browser_navigate", { operationId, action: "reload" });
  expect((await world.mcp.call("browser_fill", { operationId, ref: old, text: "wrong document" })).error?.code).toBe("STALE_ELEMENT");
  await expect(page.locator("#q")).toHaveValue("");
});

test("R20 closed current tab can switch to a remaining tab and release", async () => {
  const { page, operationId } = await setup("search.html");
  const original = await world.tabId(page);
  const newTab = await world.ok("browser_tabs", { action: "new", operationId, url: `${world.fixture.base}/form.html` });
  await world.adminPage.evaluate((tabId) => (globalThis as any).chrome.tabs.remove(tabId), newTab.data.tab.tabId);
  await expect.poll(async () => (await world.admin("status.get")).operation.currentTabClosed).toBe(true);
  expect((await world.mcp.call("browser_snapshot", { operationId })).error?.code).toBe("TAB_CLOSED");
  await world.ok("browser_tabs", { action: "switch", operationId, tabId: original });
  await page.close();
  await expect.poll(async () => (await world.admin("status.get")).operation.currentTabClosed).toBe(true);
  await world.ok("browser_tabs", { action: "release", operationId });
});

test('R25 saving the same correct pairing token repairs a halted connection',async()=>{
  await world.adminPage.reload();
  const { readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await world.killBridge();
  const path=join(world.bridge.home,'config.json');
  const config=JSON.parse(await readFile(path,'utf8'));config.pairedExtensionId='a'.repeat(32);
  await writeFile(path,JSON.stringify(config));await world.startBridge();
  await expect.poll(()=>world.adminPage.evaluate(()=> (globalThis as any).chrome.runtime.sendMessage({kind:'get-conn-status'}))).toMatchObject({state:'not_paired'});
  await world.adminPage.getByLabel('페어링 토큰', { exact: true }).fill(world.bridge.token);
  await world.adminPage.getByRole('button',{name:'저장 후 연결'}).click();
  await expect.poll(()=>world.adminPage.evaluate(()=> (globalThis as any).chrome.runtime.sendMessage({kind:'get-conn-status'}))).toMatchObject({state:'connected'});
  const listed=await world.mcp.call('browser_tabs',{action:'list'});
  if(!listed.ok){expect(listed.error?.code).toBe('BROWSER_DISCONNECTED');await world.ok('browser_tabs',{action:'list'});}
});

test('R21 resuming requires a new operation snapshot before writes',async()=>{
 const {page,operationId,snap}=await setup('search.html');const old=ref(snap,'검색어');
 await world.admin('operation.abort',{operationId});const next=await world.attach(page);
 expect((await world.mcp.call('browser_fill',{operationId:next,ref:old,text:'must not type'})).error?.code).toBe('STALE_ELEMENT');
 expect((await world.mcp.call('browser_press',{operationId:next,key:'Enter'})).error?.code).toBe('STALE_ELEMENT');
 const fresh=await snapshot(next);await world.ok('browser_fill',{operationId:next,ref:ref(fresh,'검색어'),text:'fresh'});
 await expect(page.locator('#q')).toHaveValue('fresh');expect((await world.log()).events).toEqual([]);
});
test('R22 native keyboard defaults change actual controls and radio deselection is explicit',async()=>{
 const {page,operationId}=await setup('index.html');
 await page.evaluate(()=>{document.body.innerHTML='<button id="key-button">Key button</button><input id="text" aria-label="Text" value="abc"><input type="checkbox" id="check" aria-label="Check"><input type="radio" id="radio" aria-label="Radio" checked>'; (window as any).clicks=0;document.querySelector('#key-button')!.addEventListener('click',()=>{(window as any).clicks++;});});
 const snap=await snapshot(operationId);
 await world.ok('browser_press',{operationId,ref:ref(snap,'Key button'),key:'Enter'});
 expect(await page.evaluate(()=>(window as any).clicks)).toBe(1);
 await page.locator('#text').focus();await page.locator('#text').evaluate((el:HTMLInputElement)=>el.setSelectionRange(3,3));
 await world.ok('browser_press',{operationId,ref:ref(snap,'Text'),key:'Backspace'});await expect(page.locator('#text')).toHaveValue('ab');
 await world.ok('browser_press',{operationId,ref:ref(snap,'Check'),key:'Space'});await expect(page.locator('#check')).toBeChecked();
 const radio=await world.mcp.call('browser_select',{operationId,ref:ref(snap,'Radio'),checked:false});expect(radio.ok).toBe(false);await expect(page.locator('#radio')).toBeChecked();
});
test('R23 element cursor reaches late controls and plain tables retain logical columns',async()=>{
 const {page,operationId}=await setup('index.html');
 await page.evaluate(()=>{document.body.innerHTML=Array.from({length:151},(_,i)=>`<button>B${i+1}</button>`).join('')+'<table><tr><th>Name</th><th>Value</th></tr><tr><td rowspan="2">Shared</td><td>One</td></tr><tr><td>Two</td></tr></table><table><tr><td>Second</td></tr></table>';(window as any).lastClicks=0;document.querySelectorAll('button')[150].onclick=()=>{(window as any).lastClicks++;};});
 const first=await world.ok('browser_snapshot',{operationId});expect(first.data.frames[0].elementsNextOffset).toBe(150);
 const second=await world.ok('browser_snapshot',{operationId,elementOffset:150});
 await world.ok('browser_click',{operationId,ref:ref(second.data,'B151')});expect(await page.evaluate(()=>(window as any).lastClicks)).toBe(1);
 const tables=elements(second.data).filter(e=>e.role==='table');expect(tables).toHaveLength(2);
 expect((await world.ok('browser_extract',{operationId,kind:'table',ref:tables[0].ref})).data.rows).toEqual([['Shared','One'],['Shared','Two']]);
 expect((await world.ok('browser_extract',{operationId,kind:'table',ref:tables[1].ref})).data.rows).toEqual([['Second']]);
});
test('R24 large values and tables stay bounded with usable continuations',async()=>{
 const {page,operationId}=await setup('index.html');
 await page.evaluate(()=>{document.body.innerHTML='<textarea aria-label="Large"></textarea><table>'+Array.from({length:200},(_,i)=>`<tr><td>Row ${i}</td><td>${'x'.repeat(100)}</td></tr>`).join('')+'</table>';document.querySelector('textarea')!.value='x'.repeat(500_000);});
 const snap=await world.ok('browser_snapshot',{operationId,maxChars:200});expect(JSON.stringify(snap).length).toBeLessThan(35_000);
 expect(snap.data.frames[0].limits).toContain('element-fields-truncated');
 const table=elements(snap.data).find(e=>e.role==='table')!;expect(table).toBeTruthy();
 const first=await world.ok('browser_extract',{operationId,kind:'table',ref:table.ref,maxChars:500});expect(JSON.stringify(first).length).toBeLessThan(1800);expect(first.data.nextOffset).toBeGreaterThan(0);
 const next=await world.ok('browser_extract',{operationId,kind:'table',ref:table.ref,maxChars:500,offset:first.data.nextOffset});expect(next.data.rows[0][0]).toBe(`Row ${first.data.nextOffset}`);
});
test('R26 actual worker termination during a write preserves its in-flight tombstone',async()=>{
 const {operationId,snap}=await setup('submit-once.html');
 await world.context.serviceWorkers()[0].evaluate(()=>{
  const api=(globalThis as any).chrome.tabs;const original=api.sendMessage.bind(api);
  api.sendMessage=(...args:any[])=>{const result=original(...args);return args[1]?.method==='click'?result.then(()=>new Promise(()=>{})):result;};
 });
 const commandSeen=world.relay.nextCommand('browser.click');
 const work=world.mcp.call('browser_click',{operationId,ref:ref(snap,'제출')});const command=await commandSeen;
 await expect.poll(async()=>Object.values((await world.log()).submitCounts)).toEqual([1]);
 await expect.poll(()=>world.adminPage.evaluate(async id=>((await (globalThis as any).chrome.storage.session.get('commandSession')).commandSession.requests[id!]?.state),command.id)).toBe('inflight');
 await world.restartWorker();expect((await work).error?.code).toBe('EXECUTION_UNKNOWN');
 const replay:any=await world.relay.replay(command);expect(replay.ok).toBe(false);expect(replay.error.code).toBe('EXECUTION_UNKNOWN');
 expect(Object.values((await world.log()).submitCounts)).toEqual([1]);
});
