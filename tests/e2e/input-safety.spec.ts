import { test, expect, type Page } from '@playwright/test';
import { startWorld, type World } from './harness';

let world: World;
test.beforeAll(async () => { world = await startWorld(); });
test.afterEach(async () => {
  await world.adminPage.evaluate(async () => { await (globalThis as any).chrome.storage.local.set({ trustedInput: false }); });
  const status = await world.admin('status.get');
  if (status.operation) await world.mcp.call('browser_tabs', { action: 'release', operationId: status.operation.id });
  for (const page of world.context.pages()) if (page !== world.adminPage) await page.close();
});
test.afterAll(async () => world?.stop());

async function attach(page: Page, name: string) {
  const tabId = await world.tabId(page);
  const attached = await world.ok('browser_tabs', { action: 'attach', tabId });
  const elements = attached.data.snapshot.frames.flatMap((frame: any) => frame.elements);
  return { tabId, operationId: attached.operationId!, ref: elements.find((element: any) => element.name === name)!.ref };
}

async function submitFixture() {
  const page = await world.open('quality.html');
  await page.evaluate(() => {
    document.body.innerHTML = '<button>Submit fixture</button>';
    (window as any).inputSafetyWrites = [];
    document.querySelector('button')!.addEventListener('click', event => (window as any).inputSafetyWrites.push({ trusted: event.isTrusted }));
  });
  return { page, ...await attach(page, 'Submit fixture') };
}

test('S01 cancellation during a trusted request never revives it as a DOM click', async () => {
  const { page, tabId, operationId, ref } = await submitFixture();
  // Delay only the trusted reply, in this extension's isolated content world.
  await world.adminPage.evaluate(async tabId => {
    const chrome = (globalThis as any).chrome;
    await chrome.storage.local.set({ trustedInput: true });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const chrome = (globalThis as any).chrome, send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message: any, ...rest: any[]) => {
        if (message.kind !== 'trusted-input') return send(message, ...rest);
        document.documentElement.dataset.trustedWaiting = 'yes';
        return new Promise(resolve => { (globalThis as any).finishTrusted = () => resolve({ ok: false, reason: 'not-allowed', dispatched: false }); });
      };
    } });
  }, tabId);
  const pending = world.mcp.call('browser_click', { operationId, ref });
  await expect(page.locator('html')).toHaveAttribute('data-trusted-waiting', 'yes');
  await world.admin('operation.abort', { operationId });
  await world.adminPage.evaluate(async ({ tabId, operationId }) => {
    const chrome = (globalThis as any).chrome;
    // Await content cancellation too; the assertion must not depend on transport timing.
    await chrome.tabs.sendMessage(tabId, { kind: 'cancel', operationId });
    await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
      (globalThis as any).finishTrusted();
      await new Promise(resolve => setTimeout(resolve, 0));
    } });
  }, { tabId, operationId });
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(['CANCELLED', 'EXECUTION_UNKNOWN']).toContain(result.error?.code);
  expect(await page.evaluate(() => (window as any).inputSafetyWrites)).toEqual([]);
});

test('S02 a lost trusted response never repeats an actual CDP click', async () => {
  const { page, tabId, operationId, ref } = await submitFixture();
  await world.adminPage.evaluate(async tabId => {
    const chrome = (globalThis as any).chrome;
    await chrome.storage.local.set({ trustedInput: true });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const chrome = (globalThis as any).chrome, send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async (message: any, ...rest: any[]) => {
        const result = await send(message, ...rest);
        // The native input really ran. Inject only loss of its reply.
        if (message.kind === 'trusted-input' && result?.ok) throw new Error('Injected trusted response loss');
        return result;
      };
    } });
  }, tabId);
  const result = await world.mcp.call('browser_click', { operationId, ref });
  expect(await page.evaluate(() => (window as any).inputSafetyWrites)).toEqual([{ trusted: true }]);
  expect(result).toMatchObject({ ok: false, error: { code: 'EXECUTION_UNKNOWN', retry: 'unsafe' } });
});

test('S03 a recycled record inside open shadow content invalidates its old ref', async () => {
  const page = await world.open('quality.html');
  await page.evaluate(() => {
    document.body.innerHTML = '<ul><li><div id="host"></div></li></ul>';
    const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<span>Order A</span><button>Cancel order</button>';
    (window as any).inputSafetyWrites = [];
    root.querySelector('button')!.addEventListener('click', () => (window as any).inputSafetyWrites.push(root.querySelector('span')!.textContent));
  });
  const { operationId, ref } = await attach(page, 'Cancel order');
  await page.evaluate(() => { document.querySelector('#host')!.shadowRoot!.querySelector('span')!.textContent = 'Order B'; });
  const result = await world.mcp.call('browser_click', { operationId, ref });
  expect(await page.evaluate(() => (window as any).inputSafetyWrites)).toEqual([]);
  expect(result).toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT' } });
});

test('S04 pointer feedback cannot replace an unkeyed record before click', async () => {
  const page = await world.open('quality.html');
  await page.evaluate(() => {
    document.body.innerHTML = '<li><span>Order A</span><button>Cancel order</button></li>';
    const button = document.querySelector('button')!, label = document.querySelector('span')!;
    (window as any).inputSafetyWrites = [];
    button.addEventListener('pointerdown', () => { label.textContent = 'Order B'; });
    button.addEventListener('click', () => (window as any).inputSafetyWrites.push(label.textContent));
  });
  const { operationId, ref } = await attach(page, 'Cancel order');
  const result = await world.mcp.call('browser_click', { operationId, ref });
  expect(await page.evaluate(() => (window as any).inputSafetyWrites)).toEqual([]);
  expect(result).toMatchObject({ ok: false, error: { code: 'EXECUTION_UNKNOWN', retry: 'unsafe' } });
});

test('S05 focus cannot retarget a fill to a different record', async () => {
  const page = await world.open('quality.html');
  await page.evaluate(() => {
    document.body.innerHTML = '<li data-id="A"><input aria-label="Amount" value="before"></li>';
    const field = document.querySelector('input')!, row = document.querySelector('li')!;
    (window as any).inputSafetyWrites = [];
    field.addEventListener('focus', () => { row.dataset.id = 'B'; });
    field.addEventListener('input', () => (window as any).inputSafetyWrites.push(row.dataset.id));
  });
  const { operationId, ref } = await attach(page, 'Amount');
  const result = await world.mcp.call('browser_fill', { operationId, ref, text: '100' });
  expect(await page.evaluate(() => (window as any).inputSafetyWrites)).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Amount' })).toHaveValue('before');
  expect(result).toMatchObject({ ok: false, error: { code: 'STALE_ELEMENT' } });
});
