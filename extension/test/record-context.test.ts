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

// A snapshot shows `context` for repeated controls. Whatever markup produced that context, the ref
// must stay bound to it: a recycled row must not receive the action meant for the row that was shown.
const rows = (inner: (id: string) => string) => ['A-1001', 'B-2002'].map(id => `<div class="row"><span class="id">${id}</span>${inner(id)}</div>`).join('');
it.each([
  ['p', (): string => '<p><button>Cancel</button></p>'],
  ['span', (): string => '<span><button>Cancel</button></span>'],
  ['long', (): string => `<div>${'long description '.repeat(25)}</div><button>Cancel</button>`],
  ['deep', (): string => '<div><div><div><div><button>Cancel</button></div></div></div></div>'],
] as const)('rejects a recycled row whose button is wrapped as %s', async (_kind, inner) => {
  document.body.innerHTML = rows(inner);
  const shown = snapshot().elements.find(element => element.name === 'Cancel')!;
  expect(shown.context).toContain('A-1001');
  const clicked = vi.fn(); document.querySelector('button')!.addEventListener('click', clicked);
  document.querySelector('.id')!.textContent = 'C-3003';
  const result = await runAction('click', { ref: shown.ref }).catch(error => ({ error }));
  expect(clicked).not.toHaveBeenCalled();
  expect(result).toMatchObject({ error: { code: 'STALE_ELEMENT' } });
});

it('keeps a field usable when only its own helper text changes', async () => {
  document.body.innerHTML = '<div class="field"><label for="email">Email</label><div><input id="email"></div><p class="helper"></p></div>';
  const ref = snapshot().elements.find(element => element.name === 'Email')!.ref;
  await runAction('fill', { ref, text: 'kim' });
  document.querySelector('.helper')!.textContent = 'Enter a full address';
  const second = await runAction('fill', { ref, text: 'kim@example.com' }).catch(error => ({ error }));
  expect(second).toMatchObject({ executed: true });
  expect((document.querySelector('#email') as HTMLInputElement).value).toBe('kim@example.com');
});

it.each([
  ['table row', '<table><tbody>' + ['A-1001', 'B-2002'].map(id => `<tr><td class="id">${id}</td><td><input aria-label="Quantity"></td></tr>`).join('') + '</tbody></table>'],
  ['div row', rows(() => '<input aria-label="Quantity">')],
])('still rejects a field in a recycled %s', async (_kind, markup) => {
  document.body.innerHTML = markup;
  const ref = snapshot().elements.find(element => element.name === 'Quantity')!.ref;
  document.querySelector('.id')!.textContent = 'C-3003';
  const result = await runAction('fill', { ref, text: '3' }).catch(error => ({ error }));
  expect(result).toMatchObject({ error: { code: 'STALE_ELEMENT' } });
  expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
});

it.each([
  ['a heading', '<div class="card"><h3 class="id">Order A-1001</h3><label for="q">Qty</label><input id="q"></div>'],
  ['an id line', '<div class="card"><span class="id">A-1001</span><label for="q">Qty</label><input id="q"><p class="helper"></p></div>'],
])('binds a labelled field to a card identified by %s, even when it is the only one', async (_kind, markup) => {
  document.body.innerHTML = markup;
  const ref = snapshot().elements.find(element => element.name === 'Qty')!.ref;
  document.querySelector('.id')!.textContent = 'C-3003';
  const result = await runAction('fill', { ref, text: '3' }).catch(error => ({ error }));
  expect(result).toMatchObject({ error: { code: 'STALE_ELEMENT' } });
  expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
});
