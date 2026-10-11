import test from 'node:test';
import assert from 'node:assert/strict';
import { startOpenCodeFixture } from './opencode.mjs';

test('synthetic v1 fixture authenticates, preserves typed prompt parts and consumes pending cards exactly once', async t => {
  const fixture = await startOpenCodeFixture(); t.after(() => fixture.close());
  const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + fixture.password).toString('base64'), 'Content-Type': 'application/json' };
  const request = async (path, method = 'GET', body) => fetch(fixture.origin + path, { headers, method, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await fetch(fixture.origin + '/global/health')).status, 401);
  assert.equal((await (await request('/global/health')).json()).version, '1.18.29');
  const session = await (await request('/session', 'POST', {})).json();
  const part = { type: 'file', mime: 'text/plain', filename: '합성.txt', url: 'data:text/plain;base64,ZmFrZQ==' };
  assert.equal((await request('/session/' + session.id + '/prompt_async', 'POST', { parts: [part] })).status, 204);
  const records = await (await request('/session/' + session.id + '/message')).json();
  assert.equal(records[0].parts[0].url, part.url);
  const question = fixture.addQuestion(session.id);
  assert.equal((await request('/question/' + question.id + '/reply', 'POST', { answers: [['파랑'], ['합성']] })).status, 200);
  assert.equal((await request('/question/' + question.id + '/reply', 'POST', { answers: [['파랑'], ['합성']] })).status, 404);
  assert.equal(fixture.state.replies.length, 1); assert.equal(fixture.state.modelsCalled, 0);
});
