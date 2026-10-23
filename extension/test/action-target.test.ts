import { runAction } from '../src/content/actions';
import { resetRegistry } from '../src/content/refs';
import { takeSnapshot } from '../src/content/snapshot';

beforeEach(() => { document.body.innerHTML = ''; resetRegistry(); });
afterEach(() => vi.unstubAllGlobals());
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

it.each(['input', 'textarea'].flatMap(tag => ['key', 'move', 'detach', 'rename', 'readonly', 'disabled'].map(change => ({ tag, change }))))('does not fill $tag after focus changes $change', async ({ tag, change }) => {
  document.body.innerHTML = `<ul><li data-id="A">${tag === 'input' ? '<input aria-label="Amount" value="before">' : '<textarea aria-label="Amount">before</textarea>'}</li><li data-id="B"></li></ul>`;
  const field = document.querySelector('input,textarea') as HTMLInputElement | HTMLTextAreaElement;
  const ref = refOf('Amount'), input = vi.fn(), changed = vi.fn();
  field.addEventListener('input', input); field.addEventListener('change', changed);
  field.addEventListener('focus', () => {
    if (change === 'key') document.querySelector('li')!.setAttribute('data-id', 'B');
    if (change === 'move') document.querySelectorAll('li')[1]!.append(field);
    if (change === 'detach') field.remove();
    if (change === 'rename') field.setAttribute('aria-label', 'Other amount');
    if (change === 'readonly') field.readOnly = true;
    if (change === 'disabled') field.disabled = true;
  });
  const error = await runAction('fill', { ref, text: '100' }).then(() => null, error => error);
  expect(field.value).toBe('before');
  expect(input).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  expect(error?.code).toMatch(/^(STALE_ELEMENT|ELEMENT_NOT_INTERACTABLE)$/);
});

it.each(['key', 'readonly'])('does not replace rich text after focus changes %s', async change => {
  document.body.innerHTML = '<li data-id="A"><div contenteditable="true" tabindex="0" role="textbox" aria-label="Editor">before</div></li>';
  const editor = document.querySelector('div')!, input = vi.fn();
  Object.defineProperty(editor, 'isContentEditable', { configurable: true, get: () => editor.getAttribute('contenteditable') === 'true' });
  const ref = refOf('Editor');
  editor.addEventListener('input', input);
  editor.addEventListener('focus', () => { if (change === 'key') document.querySelector('li')!.setAttribute('data-id', 'B'); else editor.setAttribute('contenteditable', 'false'); });
  const error = await runAction('fill', { ref, text: '100' }).then(() => null, error => error);
  expect(editor.textContent).toBe('before'); expect(input).not.toHaveBeenCalled();
  expect(error?.code).toMatch(/^(STALE_ELEMENT|ELEMENT_NOT_INTERACTABLE)$/);
});

it.each([false, true])('does not send a key after focus changes the record (trusted=%s)', async trusted => {
  document.body.innerHTML = '<li data-id="A"><input aria-label="Amount"></li>';
  const field = document.querySelector('input')!, ref = refOf('Amount'), keydown = vi.fn(), sendMessage = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  field.addEventListener('focus', () => { document.querySelector('li')!.setAttribute('data-id', 'B'); });
  field.addEventListener('keydown', keydown);
  const error = await runAction('press', { ref, key: 'Enter', trusted }).then(() => null, error => error);
  expect(keydown).not.toHaveBeenCalled(); expect(sendMessage).not.toHaveBeenCalled();
  expect(error).toMatchObject({ code: 'STALE_ELEMENT' });
});

it('permits focus feedback when a stable record key keeps the field bound', async () => {
  document.body.innerHTML = '<li data-id="A"><span>Idle</span><input aria-label="Amount"></li>';
  const field = document.querySelector('input')!, ref = refOf('Amount');
  field.addEventListener('focus', () => { document.querySelector('span')!.textContent = 'Focused'; });
  await expect(runAction('fill', { ref, text: '100' })).resolves.toMatchObject({ verified: { matches: true, value: '100' } });
});

it.each(['keydown', 'keypress'].flatMap(event => [true, false].map(withRef => ({ event, withRef }))))('does not activate a link changed by $event (ref=$withRef)', async ({ event, withRef }) => {
  document.body.innerHTML = '<a href="/order-A">Open order</a>';
  const link = document.querySelector('a')!, ref = refOf('Open order'), clicked = vi.fn((event: Event) => event.preventDefault());
  link.focus(); link.addEventListener(event, () => { link.href = '/order-B'; }); link.addEventListener('click', clicked);
  const error = await runAction('press', { ...(withRef ? { ref } : {}), key: 'Enter' }).then(() => null, error => error);
  expect(clicked).not.toHaveBeenCalled();
  expect(error).toMatchObject({ code: 'EXECUTION_UNKNOWN', retry: 'unsafe' });
});

it('does not click a record replaced by the Space keyup handler', async () => {
  document.body.innerHTML = '<li data-id="A"><button>Cancel order</button></li>';
  const button = document.querySelector('button')!, ref = refOf('Cancel order'), clicked = vi.fn();
  button.addEventListener('keyup', () => { document.querySelector('li')!.setAttribute('data-id', 'B'); }); button.addEventListener('click', clicked);
  const error = await runAction('press', { ref, key: 'Space' }).then(() => null, error => error);
  expect(clicked).not.toHaveBeenCalled(); expect(error).toMatchObject({ code: 'EXECUTION_UNKNOWN' });
});

it('does not edit a record replaced by beforeinput', async () => {
  document.body.innerHTML = '<li data-id="A"><input aria-label="Amount" value="before"></li>';
  const field = document.querySelector('input')!, ref = refOf('Amount'), input = vi.fn();
  field.setSelectionRange(0, field.value.length);
  field.addEventListener('beforeinput', () => { document.querySelector('li')!.setAttribute('data-id', 'B'); }); field.addEventListener('input', input);
  const error = await runAction('press', { ref, key: 'Delete' }).then(() => null, error => error);
  expect(field.value).toBe('before'); expect(input).not.toHaveBeenCalled(); expect(error).toMatchObject({ code: 'EXECUTION_UNKNOWN' });
});

it.each(['action', 'association', 'submitter', 'new-submitter'])('does not submit a form retargeted by keydown (%s)', async change => {
  document.body.innerHTML = '<form id="A" action="/order-A"><input name="amount" aria-label="Amount"><button>Save</button></form><form id="B" action="/order-B"></form>';
  const field = document.querySelector('input')!, form = document.querySelector('form')!, button = document.querySelector('button')!, ref = refOf('Amount');
  const submitted = vi.fn((event: Event) => event.preventDefault());
  for (const node of document.querySelectorAll('form')) node.addEventListener('submit', submitted);
  field.addEventListener('keydown', () => {
    if (change === 'action') form.action = '/order-B';
    if (change === 'association') field.setAttribute('form', 'B');
    if (change === 'submitter') button.setAttribute('formaction', '/order-B');
    if (change === 'new-submitter') { const replacement = document.createElement('button'); replacement.textContent = 'Other save'; form.prepend(replacement); }
  });
  const error = await runAction('press', { ref, key: 'Enter' }).then(() => null, error => error);
  expect(submitted).not.toHaveBeenCalled(); expect(error).toMatchObject({ code: 'EXECUTION_UNKNOWN' });
});

it('keeps a page-level key event valid when its handler updates page text', async () => {
  document.body.innerHTML = '<p>Waiting</p>';
  const listener = () => { document.querySelector('p')!.textContent = 'Handled'; };
  document.body.addEventListener('keydown', listener, { once: true });
  await expect(runAction('press', { key: 'Escape' })).resolves.toMatchObject({ executed: true, verified: { defaultAction: 'event-only' } });
  expect(document.querySelector('p')!.textContent).toBe('Handled');
});

it('does not send a final keyup to a control replaced by its confirmed default action', async () => {
  document.body.innerHTML = '<button>Submit</button>';
  const button = document.querySelector('button')!, ref = refOf('Submit'), keyup = vi.fn(), clicked = vi.fn();
  button.addEventListener('click', () => { clicked(); button.textContent = 'Different action'; });
  button.addEventListener('keyup', keyup);
  await expect(runAction('press', { ref, key: 'Enter' })).resolves.toMatchObject({ executed: true, verified: { defaultApplied: true, keyupSkipped: true } });
  expect(clicked).toHaveBeenCalledTimes(1); expect(keyup).not.toHaveBeenCalled();
});
