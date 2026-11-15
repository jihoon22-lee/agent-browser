import { textConditions, waitFor } from '../src/content/wait';

// A person waits for the words they see. Case from text-transform, the tab between table cells and a
// non-breaking space are not part of those words; browser_snapshot's query already ignores them.
beforeEach(() => { document.body.innerHTML = '<h2>ORDER COMPLETE</h2><pre>A-1001\tPending</pre><p>Thank you for   your order</p>'; });

it.each(['Order complete', 'A-1001 Pending', 'Thank you for your order'])('finds "%s" as it reads on screen', async text => {
  expect(textConditions({ text })).toEqual({ text: true });
  expect(await waitFor({ text, timeoutMs: 200 })).toMatchObject({ verified: { met: 'text' } });
});
it('applies the same reading to textGone and still misses different words', () => {
  expect(textConditions({ textGone: 'order complete' })).toEqual({ textGone: false });
  expect(textConditions({ text: 'Order cancelled', textGone: 'Order cancelled' })).toEqual({ text: false, textGone: true });
});
