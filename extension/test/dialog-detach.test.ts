import { advancedBrowser } from '../src/background/advanced-browser';
import { createHandlers } from '../src/background/handlers';
import { memorySessionStore } from '../src/background/dedupe';
import { trustedInput, type DebuggerApi, type TrustedInput } from '../src/background/trusted-input';
import type { ChromeApi, FrameInfo } from '../src/background/chrome-api';
import type { Req } from '../src/protocol/envelope';

const request = (method: string, params: Record<string, unknown> = {}, id: string = crypto.randomUUID()): Req => ({ v: 1, type: 'req', id, method, params: { operationId: 'op-1', generation: 1, tabId: 1, ...params } });
/** A page with a modal dialog open never answers; `blocked` models that. */
function world() {
  vi.stubGlobal('navigator', { userAgent: 'Chrome/140.0.0.0' });
  const state = { blocked: true, attached: true };
  const frames: FrameInfo[] = [{ frameId: 0, documentId: 'doc1', url: 'https://example.test/1' }];
  const tab = { id: 1, windowId: 10, active: true, url: 'https://example.test/1', title: 'Tab', status: 'complete' } as chrome.tabs.Tab;
  const reply = <T>(value: T) => state.blocked ? new Promise<T>(() => {}) : Promise.resolve(value);
  const api = {
    tabsQuery: async () => [tab], tabsGet: async () => ({ ...tab }), listFrames: async () => frames,
    inject: (_id: number, frame: FrameInfo) => reply(frame),
    sendToFrame: (_tab: number, frame: FrameInfo, msg: any) => reply(msg.kind === 'input-state' ? { document: 'd', epoch: 1 } : { ok: true, result: msg.method === 'snapshot' ? { frameId: frame.frameId, elements: [{ ref: `s${msg.params.snapshotId.toString(36)}f0e1`, name: 'Button' }], text: { content: 'fixture' } } : { executed: true, verified: {} } }),
    onTabUpdated: () => () => {}, onTabActivated: () => () => {}, onTabRemoved: () => () => {}, onCreatedNavigationTarget: () => () => {},
  } as unknown as ChromeApi;
  let event!: (tab: number, method: string, params: any) => void, detach!: (tab: number, reason: string) => void;
  const debug: DebuggerApi = { attach: async () => {}, detach: async () => {}, send: async () => ({}) as any, onDetach: fn => { detach = fn; return () => {}; }, onEvent: fn => { event = fn; return () => {}; } };
  const trusted = { isAttached: () => state.attached } as unknown as TrustedInput;
  const advanced = advancedBrowser(api, debug, trusted, () => true, async () => state.attached, async () => true, () => ({ id: 'op-1', generation: 1, tabs: [1] }));
  const h = createHandlers(api, memorySessionStore(), undefined, undefined, advanced);
  const open = () => event(1, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave?' });
  return { state, advanced, h, open, detach: () => { state.attached = false; detach(1, 'target_closed'); } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('an attached open dialog still blocks page reads', async () => {
  const w = world(); w.open();
  await expect(w.h(request('browser.snapshot'))).rejects.toMatchObject({ code: 'BROWSER_BUSY' });
});
it('after a debugger detach a dialog that is still open keeps blocking without hanging', async () => {
  vi.useFakeTimers();
  const w = world(); w.open(); w.detach();
  const read = w.h(request('browser.snapshot')).catch(error => error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await read).toMatchObject({ code: 'BROWSER_BUSY' });
  expect(w.advanced.pending(1)).toMatchObject({ state: 'uncertain', detached: true });
});
it('after a debugger detach a snapshot recovers once the person closed the dialog', async () => {
  const w = world(); w.open(); w.detach();
  w.state.blocked = false;
  // No closed event can arrive any more, yet a write is not let through before the page was read.
  await expect(w.h(request('browser.click', { ref: 's1f0e1' }))).rejects.toMatchObject({ code: 'BROWSER_BUSY' });
  await expect(w.h(request('browser.snapshot'))).resolves.toMatchObject({ tabId: 1 });
  expect(w.advanced.pending(1)).toBeUndefined();
});
it('browser.dialog list recovers a detached dialog that has closed and reports one that has not', async () => {
  vi.useFakeTimers();
  const w = world(); w.open(); w.detach();
  const listed = w.h(request('browser.dialog', { action: 'list' }));
  await vi.advanceTimersByTimeAsync(3000);
  expect(await listed).toMatchObject({ dialogs: [{ type: 'confirm', state: 'uncertain', detached: true }] });
  w.state.blocked = false;
  const again = w.h(request('browser.dialog', { action: 'list' }));
  await vi.advanceTimersByTimeAsync(3000);
  expect(await again).toEqual({ dialogs: [] });
});
it('a dialog left open when the extension itself detached is recovered the same way', async () => {
  const w = world(); w.open();
  w.state.attached = false; w.state.blocked = false; // released without an onDetach event
  await expect(w.h(request('browser.snapshot'))).resolves.toMatchObject({ tabId: 1 });
  expect(w.advanced.pending(1)).toBeUndefined();
});
it('a detach clears the trusted-input record of an open dialog', async () => {
  let event!: (tab: number, method: string, params: any) => void, detach!: (tab: number, reason: string) => void;
  const sent: string[] = [];
  const api: DebuggerApi = { attach: async () => {}, detach: async () => {}, send: async (_tab, method, params: any) => { sent.push(`${method}:${params?.type ?? ''}`); return {} as any; }, onDetach: fn => { detach = fn; return () => {}; }, onEvent: fn => { event = fn; return () => {}; } };
  const input = trustedInput(api, () => true);
  const state = { enabled: true, operationTabs: [1], operationId: 'op' };
  await input.ensure(1, state);
  event(1, 'Page.javascriptDialogOpening', { type: 'confirm' });
  detach(1, 'target_closed');
  await input.ensure(1, state);
  // A stale open-dialog mark would stop the modifier from being released after an interruption.
  let active = true; const send = api.send;
  api.send = async (tab, method, params: any) => { const r = await send(tab, method, params); if (params?.type === 'keyDown') active = false; return r as any; };
  await expect(input.key(1, 'Enter', ['Control'], () => active)).resolves.toMatchObject({ incomplete: true, keysReleased: true });
  expect(sent.filter(s => s.startsWith('Input'))).toEqual(['Input.dispatchKeyEvent:keyDown', 'Input.dispatchKeyEvent:keyUp']);
});
