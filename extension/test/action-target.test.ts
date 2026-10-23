import { runAction } from '../src/content/actions';
import { resetRegistry } from '../src/content/refs';
import { takeSnapshot } from '../src/content/snapshot';

beforeEach(() => { document.body.innerHTML = ''; resetRegistry(); });
const refOf = (name: string) => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false }).elements.find(element => element.name === name)!.ref;

it.each(['li', 'article', 'div'].flatMap(tag => ['pointerdown', 'mousedown'].map(event => ({ tag, event }))))('stops after $event changes an unkeyed $tag record', async ({ tag, event }) => {
  document.body.innerHTML = `<${tag}><span>Order A</span><button>Cancel order</button></${tag}>`;
  const button = document.querySelector('button')!, label = document.querySelector('span')!, ref = refOf('Cancel order');
  const following: string[] = []; let changed = false;
  button.addEventListener(event, () => { changed = true; label.textContent = 'Order B'; });
  for (const type of ['mousedown', 'pointerup', 'mouseup', 'click'])
    button.addEventListener(type, () => { if (changed && type !== event) following.push(type); });
  const result = await runAction('click', { ref, waitFor: { text: 'Done' } }).catch(error => ({ error }));
  expect(following).toEqual([]);
  expect(result).toMatchObject({ error: { code: 'EXECUTION_UNKNOWN', retry: 'unsafe' } });
});

it('rejects a changed record destination even when its data key stays the same', async () => {
  document.body.innerHTML = '<li data-id="A"><a href="/order-A">Details</a><button>Cancel order</button></li>';
  const button = document.querySelector('button')!, ref = refOf('Cancel order'), clicked = vi.fn();
  button.addEventListener('pointerdown', () => { document.querySelector('a')!.href = '/order-B'; });
  button.addEventListener('click', clicked);
  const result = await runAction('click', { ref, waitFor: { text: 'Done' } }).catch(error => ({ error }));
  expect(clicked).not.toHaveBeenCalled();
  expect(result).toMatchObject({ error: { code: 'EXECUTION_UNKNOWN' } });
});

it('binds a record key authored on the control itself', async () => {
  document.body.innerHTML = '<button data-id="A">Cancel order</button>';
  const button = document.querySelector('button')!, ref = refOf('Cancel order'), clicked = vi.fn();
  button.addEventListener('pointerdown', () => { button.dataset.id = 'B'; });
  button.addEventListener('click', clicked);
  const result = await runAction('click', { ref, waitFor: { text: 'Done' } }).catch(error => ({ error }));
  expect(clicked).not.toHaveBeenCalled();
  expect(result).toMatchObject({ error: { code: 'EXECUTION_UNKNOWN' } });
});

it('does not send the second click of a double click to a recycled record', async () => {
  document.body.innerHTML = '<li><span>Order A</span><button>Cancel order</button></li>';
  const button = document.querySelector('button')!, label = document.querySelector('span')!, ref = refOf('Cancel order');
  const clicked: string[] = [];
  button.addEventListener('click', () => { clicked.push(label.textContent!); label.textContent = 'Order B'; });
  const result = await runAction('click', { ref, mode: 'double', waitFor: { text: 'Done' } }).catch(error => ({ error }));
  expect(clicked).toEqual(['Order A']);
  expect(result).toMatchObject({ error: { code: 'EXECUTION_UNKNOWN' } });
});

it.each(['key', 'status'])('retains normal pointer feedback when identity is supported by %s', async kind => {
  document.body.innerHTML = `<article ${kind === 'key' ? 'data-id="A"' : ''}><span ${kind === 'status' ? 'role="status"' : ''}>Idle</span><button>Submit</button></article>`;
  const button = document.querySelector('button')!, ref = refOf('Submit'), clicked = vi.fn();
  button.addEventListener('pointerdown', () => { document.querySelector('span')!.textContent = 'Pressed'; });
  button.addEventListener('click', clicked);
  await expect(runAction('click', { ref, waitFor: { text: 'Pressed' } })).resolves.toMatchObject({ executed: true });
  expect(clicked).toHaveBeenCalledTimes(1);
});
