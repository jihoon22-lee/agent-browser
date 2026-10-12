import {test,expect} from '@playwright/test';
import {startWorld,type World} from './harness';
declare const chrome:any;
let world:World,folder:string,nested:string;
test.beforeAll(async()=>{
 test.skip(process.env.AB_TEST_BOOKMARKS!=='1','Isolated synthetic bookmark permission fixture only');
 world=await startWorld();console.log('BOOKMARK fixture runtime '+JSON.stringify(world.runtime));
 const fixture=await world.adminPage.evaluate(async(base)=>{
  const roots=await chrome.bookmarks.getChildren('0');
  const root=await chrome.bookmarks.create({parentId:roots.find((n:any)=>!n.url).id,title:'AgentBrowser test root'});
  const child=await chrome.bookmarks.create({parentId:root.id,title:'Fixture folder'});
  for(let i=1;i<=3;i++)await chrome.bookmarks.create({parentId:root.id,title:'Synthetic Fixture '+i,url:base+'/board.html?post='+i});
  await chrome.bookmarks.create({parentId:child.id,title:'Nested fixture',url:base+'/board.html'});
  return {folder:root.id,nested:child.id};
 },world.fixture.base);folder=fixture.folder;nested=fixture.nested;
});
test.afterAll(async()=>{await world?.stop();});
test('F01 root and nested folder navigation, pagination',async()=>{
 const roots=await world.ok('browser_bookmarks',{action:'list'});expect(roots.data.entries.every((n:any)=>n.type==='folder')).toBe(true);
 const first=await world.ok('browser_bookmarks',{folderId:folder,limit:2});expect(first.data.nextOffset).toBe(2);
 const next=await world.ok('browser_bookmarks',{folderId:folder,limit:2,offset:first.data.nextOffset});expect(next.data.nextOffset).toBe(null);
 expect((await world.ok('browser_bookmarks',{folderId:nested})).data.entries[0].title).toBe('Nested fixture');
});
test('F02 search and metadata reads do not visit links or allow bookmark writes',async()=>{
 const pages=world.context.pages().map(p=>p.url());
 const result=await world.ok('browser_bookmarks',{action:'search',query:'Synthetic Fixture',limit:1});
 expect(result.data.total).toBe(3);expect(result.data.entries[0].url).toContain(world.fixture.base);
 expect(world.context.pages().map(p=>p.url())).toEqual(pages);
 expect((await world.mcp.call('browser_bookmarks',{action:'delete',folderId:folder})).error?.code).toBe('INVALID_PARAMS');
 expect((await world.ok('browser_bookmarks',{folderId:folder})).data.total).toBe(4);
});
