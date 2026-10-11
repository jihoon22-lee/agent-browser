import type { ChromeApi } from './chrome-api';
import { aborted, describeTab, isWeb } from './tabs';

type Target = chrome.webNavigation.WebNavigationSourceCallbackDetails;
type Api = Pick<ChromeApi,'tabsGet'|'onTabUpdated'|'onTabRemoved'|'onCreatedNavigationTarget'>;
type Child = ReturnType<typeof describeTab> & {sourceTabId:number;sourceFrameId:number};
type Warning = {tabId:number;reason:'closed'|'unsupported'|'load-timeout'};

/** Chrome provides the real navigation source even for noopener links. Registration
 * is scoped to one dispatched action, never to the user's current/active tab. */
export function trackCreatedTabs(api: Api, sourceTabId: number, sourceFrameId: number, signal: AbortSignal) {
  const targets = new Map<number,Pick<Target,'tabId'>>(), closed = new Set<number>();
  const offCreated = api.onCreatedNavigationTarget(target => {
    if (!signal.aborted && target.sourceTabId === sourceTabId && target.sourceFrameId === sourceFrameId && target.tabId !== sourceTabId && targets.size < 16) targets.set(target.tabId,{tabId:target.tabId});
  });
  const offRemoved = api.onTabRemoved(id => { closed.add(id); });
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; offCreated(); offRemoved(); } };
  async function loaded(target: Pick<Target,'tabId'>): Promise<Child|Warning> {
    if (closed.has(target.tabId)) return {tabId:target.tabId,reason:'closed'};
    return new Promise((resolve,reject) => {
      let done = false;
      const complete = (value:Child|Warning) => { if (done) return; done = true; cleanup(); resolve(value); };
      const stop = () => { if (done) return; done = true; cleanup(); reject(signal.reason); };
      const check = (tab:chrome.tabs.Tab) => {
        if (closed.has(target.tabId)) return complete({tabId:target.tabId,reason:'closed'});
        if (tab.status === 'complete' && isWeb(tab.url)) complete({...describeTab(tab),url:tab.url?.slice(0,2048)??'',title:tab.title?.slice(0,256)??'',sourceTabId,sourceFrameId});
        else if (tab.url && tab.url !== 'about:blank' && !isWeb(tab.url)) complete({tabId:target.tabId,reason:'unsupported'});
      };
      const offUpdate = api.onTabUpdated((id,_change,tab) => { if (id === target.tabId) check(tab); });
      const offClose = api.onTabRemoved(id => { if (id === target.tabId) complete({tabId:id,reason:'closed'}); });
      const timer = setTimeout(() => complete({tabId:target.tabId,reason:'load-timeout'}),10_000);
      function cleanup() { clearTimeout(timer); offUpdate(); offClose(); signal.removeEventListener('abort',stop); }
      signal.addEventListener('abort',stop,{once:true});
      if (signal.aborted) { stop(); return; }
      void api.tabsGet(target.tabId).then(check,() => complete({tabId:target.tabId,reason:'closed'}));
    });
  }
  return {
    dispose,
    async finish() {
      try {
        aborted(signal);
        // Key actions can acknowledge before Chrome delivers its target event.
        await new Promise<void>((resolve,reject) => {
          const stop = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort',stop); resolve(); },100);
          signal.addEventListener('abort',stop,{once:true}); if (signal.aborted) stop();
        });
        offCreated();
        const results = await Promise.all([...targets.values()].map(loaded)); aborted(signal);
        const openedTabs = results.filter((result):result is Child => !('reason' in result) && !closed.has(result.tabId!));
        const openedTabWarnings = results.filter((result):result is Warning => 'reason' in result);
        return {...(openedTabs.length ? {openedTabs} : {}),...(openedTabWarnings.length ? {openedTabWarnings} : {})};
      } finally { dispose(); }
    },
  };
}
