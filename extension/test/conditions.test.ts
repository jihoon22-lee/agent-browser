import { runAction } from '../src/content/actions';
import { waitFor } from '../src/content/wait';

beforeEach(()=>{document.body.innerHTML='<p>Loading</p>';vi.useFakeTimers();});
afterEach(()=>vi.useRealTimers());
it('all text conditions wait for every condition, preserving any as the legacy default',async()=>{
  let done=false;
  const waiting=waitFor({text:'Ready',textGone:'Loading',match:'all',timeoutMs:1000}).then(r=>{done=true;return r;});
  document.body.innerHTML='<p>Ready Loading</p>';
  await vi.advanceTimersByTimeAsync(1);expect(done).toBe(false);
  document.body.innerHTML='<p>Ready</p>';
  await expect(waiting).resolves.toMatchObject({verified:{met:'all'}});
});
it('a condition probe only returns booleans, never page text or input data',async()=>{
  document.body.innerHTML='<p>Ready confidential fixture text</p>';
  const result=await runAction('conditions',{text:'Ready',textGone:'Loading'});
  expect(result).toEqual({conditions:{text:true,textGone:true}});
  expect(JSON.stringify(result)).not.toContain('confidential');
});
