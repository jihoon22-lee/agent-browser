import {test,expect} from '@playwright/test';
import {startWorld,type World} from './harness';
import {startOpenCodeFixture} from '../fixtures/opencode.mjs';
declare const chrome:any;
let world:World,api:Awaited<ReturnType<typeof startOpenCodeFixture>>;
const panel=(message:any)=>world.adminPage.evaluate(m=>chrome.runtime.sendMessage(m),message);
const saved=()=>world.adminPage.evaluate(async()=> (await chrome.storage.local.get('panelBrowserRequest')).panelBrowserRequest);
test.beforeEach(async()=>{
  world=await startWorld();api=await startOpenCodeFixture();
  await world.admin('profile.save',{profile:{id:'fixture',name:'Fixture',kind:'external',baseUrl:api.origin,username:api.username,password:api.password,directory:api.directory}});
});
test.afterEach(async()=>{await world?.stop();await api?.close();});
async function prepare(id:string,profileId='fixture'){
  const session=api.session(),page=await world.open('board.html');
  const lease={requestId:id,messageId:'msg-'+id,sessionId:session.id,profileId,directory:api.directory};
  expect((await panel({kind:'request-prepare',lease,target:{tabId:await world.tabId(page),windowId:1}})).ok).toBe(true);
  return {lease,page};
}
test('F3 Stop cancels old operations and blocks an immediate unscoped attach',async()=>{
  const {lease,page}=await prepare('stop');
  const op=await world.ok('browser_tabs',{action:'attach',requestId:lease.requestId});
  expect((await panel({kind:'request-cancel',scope:lease})).ok).toBe(true);
  expect(await saved()).toBeUndefined();
  expect((await world.mcp.call('browser_snapshot',{operationId:op.operationId})).error?.code).toBe('CANCELLED');
  expect((await world.mcp.call('browser_tabs',{action:'attach',tabId:await world.tabId(page)})).error?.code).toBe('CANCELLED');
  const next=await prepare('next');
  await world.ok('browser_tabs',{action:'attach',requestId:next.lease.requestId});
});
test('F1 an unavailable lease can be cancelled and another profile can submit',async()=>{
  const {lease}=await prepare('unavailable','deleted-profile');
  expect((await panel({kind:'request-cancel',scope:lease})).ok).toBe(true);
  expect(await saved()).toBeUndefined();
  await prepare('another-unavailable','deleted-profile');
  await prepare('replacement');
  expect((await saved()).profileId).toBe('fixture');
});
test('F1 deleting the owning profile removes its lease',async()=>{
  await prepare('deleted');
  await world.admin('profile.delete',{profileId:'fixture'});
  expect(await saved()).toBeUndefined();
});
test('F16 background completion frees a panel reservation for CLI without opening a panel',async()=>{
  const {lease,page}=await prepare('complete');
  const op=await world.ok('browser_tabs',{action:'attach',requestId:lease.requestId});
  await world.ok('browser_tabs',{action:'release',operationId:op.operationId});
  api.saveMessage({info:{id:'reply',role:'assistant',parentID:lease.messageId,sessionID:lease.sessionId,time:{created:Date.now(),completed:Date.now()},finish:'stop'},parts:[]});
  api.state.statuses[lease.sessionId]={type:'idle'};
  // Exercise the production timer/alarm, not an artificial request-finish call.
  await expect.poll(saved,{timeout:40_000}).toBeUndefined();
  await world.ok('browser_tabs',{action:'attach',tabId:await world.tabId(page)});
});
