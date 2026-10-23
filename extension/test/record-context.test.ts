import { takeSnapshot } from '../src/content/snapshot';
import { resetRegistry, resolveRef } from '../src/content/refs';
import { observeRecord } from '../src/content/record-context';
import { runAction } from '../src/content/actions';

const snapshot = () => takeSnapshot({ snapshotId: 1, frameId: 0, maxChars: 4000, offset: 0, checkLayout: false });
beforeEach(() => { document.body.innerHTML = ''; resetRegistry(); });

it.each(['list', 'card', 'nested'])('rejects a recycled %s record whose identity is in open shadow content', async kind => {
  document.body.innerHTML = kind === 'card' ? '<div id="host"></div>' : '<ul><li><div id="host"></div></li></ul>';
  let root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  if (kind === 'nested') { root.innerHTML = '<div id="inner"></div>'; root = root.querySelector('#inner')!.attachShadow({ mode: 'open' }); }
  root.innerHTML = '<span>Order A</span><button>Cancel order</button>';
  const ref = snapshot().elements.find(element => element.name === 'Cancel order')!.ref;
  const clicked = vi.fn(); root.querySelector('button')!.addEventListener('click', clicked);
  root.querySelector('span')!.textContent = 'Order B';
  const result = await runAction('click', { ref, waitFor: { text: 'Done' } }).catch(error => ({ error }));
  expect(clicked).not.toHaveBeenCalled();
  expect(result).toMatchObject({ error: { code: 'STALE_ELEMENT' } });
});

it('reads assigned slot content once and excludes unassigned light DOM from the rendered record', () => {
  document.body.innerHTML = '<li><div id="host"><span slot="title">Order A</span><span>Unassigned record</span><button slot="action">Cancel</button></div></li>';
  document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<slot name="title"></slot><slot name="action"></slot>';
  const observation = observeRecord(document.querySelector('li')!);
  expect(observation.text).toBe('Order A');
  expect(observation.search).toBe('Order ACancel');
});

it('rejects a slotted button moved into a different shadow record', () => {
  document.body.innerHTML = '<div id="host"><button slot="left">Cancel</button></div>';
  document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML = '<ul><li data-id="A"><span>Order A</span><slot name="left"></slot></li><li data-id="B"><span>Order B</span><slot name="right"></slot></li></ul>';
  const ref = snapshot().elements.find(element => element.name === 'Cancel')!.ref;
  document.querySelector('button')!.slot = 'right';
  expect(() => resolveRef(ref)).toThrowError(expect.objectContaining({ code: 'STALE_ELEMENT' }));
});

it('retains a shadow record while fields and declared live feedback change', async () => {
  document.body.innerHTML = '<li data-id="A"><div id="host"></div></li>';
  const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  root.innerHTML = '<span>Order A</span><input aria-label="Amount"><span role="status">Pending</span><button>Save</button>';
  const elements = snapshot().elements, ref = elements.find(element => element.name === 'Save')!.ref;
  await runAction('fill', { ref: elements.find(element => element.name === 'Amount')!.ref, text: '100' });
  root.querySelector('[role=status]')!.textContent = 'Updated';
  expect(resolveRef(ref)).toBe(root.querySelector('button'));
});
