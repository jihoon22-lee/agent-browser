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
it('cancellation markers are pruned after the session TTL',async()=>{
 vi.useFakeTimers();try {
  const backing=new Map<string,unknown>(),s=memorySessionStore(backing);
  const t0=Date.now();
  for(let i=0;i<500;i++) await s.cancel({requestId:'r'+i});
  const cancelled=()=>(backing.get('commandSession') as {cancelled:Record<string,number>}).cancelled;
  expect(Object.keys(cancelled())).toHaveLength(500);
  vi.setSystemTime(t0+9*60_000);
  expect(await s.isCancelled('r0',{})).toBe(true);
  expect(Object.keys(cancelled())).toHaveLength(500);
  vi.setSystemTime(t0+10*60_000+1);
  expect(await s.isCancelled('r0',{})).toBe(false);
  expect(Object.keys(cancelled())).toHaveLength(0);
 }finally{vi.useRealTimers();}
});
class CountingMap extends Map<string,unknown> {
    writes=0;
    override set(key:string,value:unknown){this.writes++;return super.set(key,value);}
}
it('read-only transactions skip writes unless something was pruned',async()=>{
 vi.useFakeTimers();try {
  const backing=new CountingMap(),s=memorySessionStore(backing);
  await s.getResult('x');await s.isCancelled('x',{});await s.hasSnapshot('op');await s.binding(1,0);
  expect(backing.writes).toBe(0);
  await s.claim('x');expect(backing.writes).toBe(1);
  await s.saveResult('x',{ok:true,result:1});expect(backing.writes).toBe(2);
  await s.cancel({requestId:'x'});expect(backing.writes).toBe(3);
  await s.bind(1,[]);expect(backing.writes).toBe(4);
  await s.nextSnapshotId();expect(backing.writes).toBe(5);
  const t0=Date.now();
  await s.saveResult('expired',{ok:true,result:1});expect(backing.writes).toBe(6);
  vi.setSystemTime(t0+11*60_000);
  await s.getResult('expired');expect(backing.writes).toBe(7);
  const state=backing.get('commandSession') as {requests:Record<string,unknown>;cancelled:Record<string,number>};
  expect(state.requests).toEqual({});expect(state.cancelled).toEqual({});
 }finally{vi.useRealTimers();}
});
