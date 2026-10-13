import { test, expect, type Page } from '@playwright/test';
import { startWorld, type World } from './harness';

declare const chrome: any;
let world: World;
async function setup() {
  const page = await world.open('new-tabs.html'); const operationId = await world.attach(page);
  const snapshot = (await world.ok('browser_snapshot', { operationId })).data;
  const ref = (name: string) => {
    const matches = snapshot.frames.flatMap((frame: any) => frame.elements).filter((element: any) => element.name === name);
    expect(matches).toHaveLength(1); return matches[0].ref as string;
  };
  return { page, operationId, original: await world.tabId(page), ref };
}
async function nextChild(): Promise<Page> {
  return world.context.waitForEvent('page', { predicate: page => page !== world.adminPage });
}
test.beforeAll(async ({}, info) => {
  world = await startWorld(); await info.attach('runtime', {body:JSON.stringify(world.runtime),contentType:'application/json'});
  console.log(`New-tab E2E runtime: ${JSON.stringify(world.runtime)}`);
});
test.afterEach(async () => {
  world.relay.clearHolds();
  const status = await world.admin('status.get');
  if (status.operation) await world.mcp.call('browser_tabs',{action:'release',operationId:status.operation.id});
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
});

test('N03 a child closed after the click response was produced cannot be resurrected by that response',async()=>{
  const {operationId,original,ref} = await setup();world.relay.holdReplies('browser.click');
  const commandSeen = world.relay.nextCommand('browser.click'), popup = nextChild();
  const clicking = world.mcp.call('browser_click',{operationId,ref:ref('새 탭 링크')});
  const command = await commandSeen, child = await popup;await child.waitForURL('**/new-tab-child.html?kind=blank');const childId = await world.tabId(child);
  await world.relay.waitHeld(command.id!);const closed=world.relay.nextEvent('tab.closed',data=>data.tabId===childId);await child.close();await closed;
  // Both frames use the original upstream connection: tab.closed is sent before
  // the artificially delayed result, without relying on a timing sleep.
  world.relay.releaseHeld(command.id!);
  const result = await clicking;expect(result.ok).toBe(true);expect(result.data.openedTabs).toEqual(expect.arrayContaining([expect.objectContaining({tabId:childId,adopted:false})]));
  const status = await world.admin('status.get');expect(status.operation.currentTab).toBe(original);expect(status.operation.tabs).not.toContain(childId);
  expect((await world.ok('browser_snapshot',{operationId})).data.tabId).toBe(original);
});

test('N04 abort and replacement operation reject an old click child even when its reply arrives later',async()=>{
  const {page,operationId,original,ref} = await setup();world.relay.holdReplies('browser.click');
  const commandSeen = world.relay.nextCommand('browser.click'), popup = nextChild();
  const clicking = world.mcp.call('browser_click',{operationId,ref:ref('새 탭 링크')});
  const command = await commandSeen, child = await popup;await child.waitForURL('**/new-tab-child.html?kind=blank');const childId = await world.tabId(child);
  await world.relay.waitHeld(command.id!);await world.admin('operation.abort',{operationId});
  const second = await world.newMcp();const replacement = await world.attach(page,second);
  world.relay.releaseHeld(command.id!);const old = await clicking;expect(old.data.abortedAfter).toBe(true);
  const status = await world.admin('status.get');expect(status.operation.id).toBe(replacement);expect(status.operation.currentTab).toBe(original);expect(status.operation.tabs).not.toContain(childId);
});

test('N05 another opener during the agent click does not enter the operation',async()=>{
  const {operationId,original,ref} = await setup();const other = await world.open('new-tabs.html?other=1');
  await other.locator('a').evaluate((link:HTMLAnchorElement)=>{link.href='/new-tab-child.html?kind=other-opener';link.rel='opener';});
  const commandSeen = world.relay.nextCommand('browser.click');const clicking = world.ok('browser_click',{operationId,ref:ref('새 탭 링크')});await commandSeen;
  const unrelated = other.waitForEvent('popup');await other.locator('a').click();const userChild=await unrelated;await userChild.waitForLoadState();
  const result=await clicking;const userId=await world.tabId(userChild);expect(result.data.openedTabs.every((tab:any)=>tab.sourceTabId===original&&tab.tabId!==userId)).toBe(true);
  expect((await world.admin('status.get')).operation.tabs).not.toContain(userId);
});

test('N06 keyboard link activation also adopts its new tab and requires a fresh snapshot',async()=>{
  const {operationId,ref} = await setup();const popup=nextChild();await world.ok('browser_press',{operationId,ref:ref('새 탭 링크'),key:'Enter'});const child=await popup;await child.waitForLoadState();
  expect((await world.mcp.call('browser_press',{operationId,key:'Enter'})).error?.code).toBe('STALE_ELEMENT');
  expect((await world.ok('browser_snapshot',{operationId})).data.tabId).toBe(await world.tabId(child));
});

test('N07 a user popup from the same source frame during an agent action is not adopted',async()=>{
  const {page,operationId,original,ref} = await setup();
  await page.locator('#original-note').evaluate(input => input.addEventListener('click', () => input.setAttribute('data-clicked','true')));
  const commandSeen = world.relay.nextCommand('browser.click');
  const clicking = world.ok('browser_click',{operationId,ref:ref('원본 메모')});
  await commandSeen;
  // Wait until the agent's synthetic click has run, then intervene during its
  // observation interval with a real browser input event on the same document.
  await expect(page.locator('#original-note')).toHaveAttribute('data-clicked','true');
  const popup = nextChild();await page.locator('a').click();const child = await popup;
  const result = await clicking, childId = await world.tabId(child);
  expect(result.data.openedTabs ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({tabId:childId})]));
  expect(result.data.openedTabWarnings).toContainEqual({tabId:childId,reason:'user-intervention'});
  const status = await world.admin('status.get');expect(status.operation.currentTab).toBe(original);expect(status.operation.tabs).not.toContain(childId);
});
test.afterAll(async () => { await world?.stop(); });

for (const [name,kind] of [['새 탭 링크','blank'],['스크립트 새 탭','script'],['주소가 늦게 정해지는 새 탭','delayed']]) {
  test(`N01 ${kind}: click-created child joins operation, gets fresh refs, and returns to original`, async () => {
    const {page,operationId,original,ref} = await setup();
    const popup = nextChild(); const clicked = await world.ok('browser_click',{operationId,ref:ref(name)}); const child = await popup;
    await child.waitForURL(`**/new-tab-child.html?kind=${kind}`);
    const childId = await world.tabId(child);
    const current = (await world.ok('browser_snapshot',{operationId})).data;
    expect(current.tabId).toBe(childId); expect(current.url).toContain(`/new-tab-child.html?kind=${kind}`);
    expect(clicked.data.openedTabs).toEqual(expect.arrayContaining([expect.objectContaining({tabId:childId,sourceTabId:original})]));
    const nextRef = current.frames.flatMap((frame:any)=>frame.elements).find((element:any)=>element.name==='새 탭 메모').ref;
    await world.ok('browser_fill',{operationId,ref:nextRef,text:'새 탭에서 계속'}); await expect(child.locator('#child-note')).toHaveValue('새 탭에서 계속');
    expect((await world.mcp.call('browser_fill',{operationId,ref:ref('원본 메모'),text:'잘못된 탭'})).error?.code).toBe('STALE_ELEMENT');
    await world.ok('browser_tabs',{action:'switch',operationId,tabId:original});
    expect((await world.ok('browser_snapshot',{operationId})).data.url).toBe(page.url());
  });
}

test('N02 unrelated user-created tab is not added or selected',async()=>{
  const {operationId,original} = await setup(); const unrelated = await world.open('new-tab-child.html?kind=user'); const id = await world.tabId(unrelated);
  const status = await world.admin('status.get'); expect(status.operation.currentTab).toBe(original); expect(status.operation.tabs).not.toContain(id);
  await world.ok('browser_tabs',{action:'switch',operationId,tabId:id});
  expect((await world.ok('browser_snapshot',{operationId})).data.tabId).toBe(id);
});
