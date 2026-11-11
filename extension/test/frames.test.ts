import { frameRouter } from '../src/background/frames';
import { memorySessionStore } from '../src/background/dedupe';
import type { ChromeApi, FrameInfo } from '../src/background/chrome-api';

function world() {
  const cancelled: string[] = [];
  let removed!: (id: number) => void;
  const api = {
    listFrames: async () => [], inject: async (_tab: number, frame: FrameInfo) => frame,
    sendToFrame: async (tabId: number, frame: FrameInfo) => { cancelled.push(`${tabId}:${frame.documentId}`); },
    onTabRemoved: (fn: (id: number) => void) => { removed = fn; return () => {}; },
  } as unknown as ChromeApi;
  return { router: frameRouter(api, memorySessionStore()), cancelled, removed: (id: number) => removed(id) };
}
const frame = (frameId: number, documentId: string): FrameInfo => ({ frameId, documentId, url: 'https://example.test/' });

it('forgets a replaced document and a closed tab instead of cancelling into them forever', async () => {
  const w = world();
  await w.router.inject(1, frame(0, 'old'));
  await w.router.inject(1, frame(7, 'child'));
  await w.router.inject(1, frame(0, 'new'));
  await w.router.inject(2, frame(0, 'other'));
  w.router.cancel({ requestId: 'r1' });
  expect(w.cancelled.sort()).toEqual(['1:child', '1:new', '2:other']);
  w.cancelled.length = 0; w.removed(1);
  w.router.cancel({ requestId: 'r2' });
  expect(w.cancelled).toEqual(['2:other']);
});
