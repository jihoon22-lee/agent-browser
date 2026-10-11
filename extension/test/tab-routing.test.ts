import { trackCreatedTabs } from '../src/background/tab-routing';
import type { ChromeApi } from '../src/background/chrome-api';

type Target = chrome.webNavigation.WebNavigationSourceCallbackDetails;
function fixture() {
  const tabs = new Map<number,chrome.tabs.Tab>();
  const targets = new Set<(target:Target)=>void>(), removed = new Set<(id:number)=>void>(), updated = new Set<(id:number,change:chrome.tabs.OnUpdatedInfo,tab:chrome.tabs.Tab)=>void>();
  const api:Pick<ChromeApi,'tabsGet'|'onTabUpdated'|'onTabRemoved'|'onCreatedNavigationTarget'> = {
    tabsGet:async id=>{const tab=tabs.get(id);if(!tab)throw Error('closed');return {...tab};},
    onTabUpdated:fn=>{updated.add(fn);return()=>{updated.delete(fn);};}, onTabRemoved:fn=>{removed.add(fn);return()=>{removed.delete(fn);};},
    onCreatedNavigationTarget:fn=>{targets.add(fn);return()=>{targets.delete(fn);};},
  };
  const tab=(id:number,url='https://fixture.test/child',status='complete')=>{const value={id,url,status,windowId:1,active:false,title:'Fixture'} as chrome.tabs.Tab;tabs.set(id,value);return value;};
  const opened=(id:number,sourceTabId=1,sourceFrameId=0)=>{for(const fn of targets)fn({tabId:id,sourceTabId,sourceFrameId,sourceProcessId:1,timeStamp:Date.now(),url:tabs.get(id)?.url??'about:blank'});};
  return {api,tabs,targets,removed,updated,tab,opened};
}
beforeEach(()=>vi.useFakeTimers()); afterEach(()=>vi.useRealTimers());

it('uses Chrome source tab/frame during the action rather than active tab or opener guesses',async()=>{
  const w=fixture(),controller=new AbortController(); const tracking=trackCreatedTabs(w.api,1,0,controller.signal);
  w.tab(9);w.opened(9);w.tab(10);w.opened(10,2);w.tab(11);w.opened(11,1,7);w.tab(12);
  const result=tracking.finish();await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({openedTabs:[{tabId:9,sourceTabId:1,sourceFrameId:0}]});expect(w.targets.size+w.removed.size+w.updated.size).toBe(0);
});
it('waits for an about:blank child to finish its final HTTP navigation',async()=>{
  const w=fixture(),tracking=trackCreatedTabs(w.api,1,0,new AbortController().signal);w.tab(9,'about:blank');w.opened(9);
  const result=tracking.finish();let done=false;void result.then(()=>{done=true;});await vi.advanceTimersByTimeAsync(100);expect(done).toBe(false);
  const tab=w.tab(9);for(const fn of w.updated)fn(9,{status:'complete'},tab);
  expect(await result).toMatchObject({openedTabs:[{tabId:9,url:'https://fixture.test/child'}]});
});
it('does not adopt closed children or final unsupported pages',async()=>{
  const w=fixture(),tracking=trackCreatedTabs(w.api,1,0,new AbortController().signal);w.tab(9);w.opened(9);for(const fn of w.removed)fn(9);w.tabs.delete(9);
  w.tab(10,'chrome://settings');w.opened(10);
  const result=tracking.finish();await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual({openedTabWarnings:[{tabId:9,reason:'closed'},{tabId:10,reason:'unsupported'}]});
});
it('abort while child navigation is pending removes every listener and cannot adopt its later load',async()=>{
  const w=fixture(),controller=new AbortController(),tracking=trackCreatedTabs(w.api,1,0,controller.signal);w.tab(9,'about:blank');w.opened(9);
  const result=tracking.finish();const rejected=expect(result).rejects.toThrow('stopped');await vi.advanceTimersByTimeAsync(100);controller.abort(Error('stopped'));await rejected;
  expect(w.targets.size+w.removed.size+w.updated.size).toBe(0);
});
