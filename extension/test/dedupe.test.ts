import { memorySessionStore } from '../src/background/dedupe';
it('concurrent claims allow one write and preserve other request records', async () => {
    const s = memorySessionStore();
    const r = await Promise.all([s.claim('a'), s.claim('a'), s.claim('b')]);
    expect(r.filter(x => x === undefined)).toHaveLength(2);
    await Promise.all([s.saveResult('a', { ok: true, result: 'A' }), s.saveResult('b', { ok: true, result: 'B' })]);
    expect(await s.getResult('a')).toMatchObject({ state: 'done', outcome: { result: 'A' } });
    expect(await s.getResult('b')).toMatchObject({ state: 'done', outcome: { result: 'B' } });
});
it('snapshot numbers do not collide across tabs or store reconstruction', async () => {
    const backing = new Map<string, unknown>(), s = memorySessionStore(backing);
    const ids = await Promise.all(Array.from({ length: 12 }, () => s.nextSnapshotId()));
    expect(new Set(ids).size).toBe(12);
    expect(await memorySessionStore(backing).nextSnapshotId()).toBeGreaterThan(Math.max(...ids));
});
it('an interrupted write is not made replayable by cache expiry',async()=>{
 vi.useFakeTimers();try {
  const s=memorySessionStore();await s.markInFlight('interrupted');
  vi.setSystemTime(Date.now()+11*60_000);
  expect(await s.claim('interrupted')).toMatchObject({state:'inflight'});
 }finally{vi.useRealTimers();}
});
