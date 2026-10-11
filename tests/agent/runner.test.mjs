import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, isolatedEnvironment, assertResolvedConfig, parseModelCatalog, verifyFreeModel, scoreRun, stopReason, verifyOfficialPricing } from './runner-lib.mjs';

const selected = 'opencode/synthetic-free';
const options = { model: selected, exe: '/mnt/c/Agent Browser 테스트/browser-bridge.exe', bridgeHome: 'C:\\Agent Browser 테스트\\home', bridgePort: 4317 };
const free = { id: 'synthetic-free', providerID: 'opencode', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, capabilities: { toolcall: true } };

test('isolated config restricts every model, provider, agent and tool without rewriting paths', () => {
  const config = buildConfig(options);
  assert.equal(config.model, selected);
  assert.equal(config.small_model, selected);
  assert.deepEqual(config.enabled_providers, ['opencode']);
  assert.deepEqual(config.provider.opencode.whitelist, ['synthetic-free']);
  assert.deepEqual(config.mcp.browser.command, [options.exe, 'mcp']);
  assert.equal(config.mcp.browser.environment.AGENT_BROWSER_HOME, options.bridgeHome);
  assert.equal(config.permission['*'], 'deny');
});

test('all built-in and custom agent overrides use the selected model with no subagents', () => {
  const config = buildConfig(options);
  for (const name of ['build', 'plan', 'general', 'explore', 'title', 'summary', 'compaction', 'browser-test']) assert.equal(config.agent[name].model, selected);
  assert.equal(config.agent.general.disable, true);
  assert.equal(config.agent.explore.disable, true);
  assert.equal(config.subagent_depth, 0);
  assert.equal(config.permission['browser_*'], 'allow');
  assert.throws(() => buildConfig({ ...options, model: 'other/paid' }), /opencode/);
});

test('inherited config, model metadata injection and credentials cannot bypass isolation', () => {
  const env = isolatedEnvironment({ PATH: '/bin', HOME: '/real', OPENCODE_CONFIG_CONTENT: '{"model":"other/paid"}', OPENCODE_MODELS_PATH: '/fake-models', OPENCODE_API_KEY: 'do-not-copy', OPENAI_API_KEY: 'also-private', AGENT_BROWSER_HOME: 'real-home' }, '/tmp/isolated', '/tmp/isolated/config.json');
  assert.equal(env.OPENCODE_CONFIG, '/tmp/isolated/config.json');
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(env.OPENCODE_MODELS_PATH, undefined);
  assert.equal(env.OPENCODE_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AGENT_BROWSER_HOME, undefined);
  assert.equal(env.HOME, '/real');
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/isolated/config');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, 'true');
});

test('resolved configuration detects inherited extra MCP, paid overrides and widened tools', () => {
  const config = buildConfig(options);
  assert.doesNotThrow(() => assertResolvedConfig(config, options));
  for (const mutate of [c => { c.mcp.other = { enabled: true }; }, c => { c.agent.title.model = 'other/paid'; }, c => { c.permission.bash = 'allow'; }, c => { c.provider.opencode.whitelist.push('paid'); }, c => { c.agent['browser-test'].permission.bash = 'allow'; }]) {
    const poisoned = structuredClone(config); mutate(poisoned);
    assert.throws(() => assertResolvedConfig(poisoned, options));
  }
});

test('zero price is verified for input, output, caches and every price tier, independent of model name', () => {
  assert.equal(verifyFreeModel(selected, [free]).id, 'synthetic-free');
  const missing = structuredClone(free); delete missing.cost.cache;
  const tiered = structuredClone(free); tiered.cost.tiers = [{ input: 0, output: 1, cache: { read: 0, write: 0 } }];
  for (const model of [missing, tiered, { ...free, capabilities: { toolcall: false } }, { ...free, cost: { ...free.cost, input: 1 } }]) assert.throws(() => verifyFreeModel(selected, [model]));
  assert.throws(() => verifyFreeModel(selected, []), /metadata/);
});

test('verbose catalogue parser handles brace characters inside JSON strings', () => {
  const record = { ...free, name: 'Synthetic { "test" }' };
  const raw = `${selected}\n${JSON.stringify(record, null, 2)}\n`;
  assert.deepEqual(parseModelCatalog(raw), [record]);
});

const outcome = (tool, data) => ({ ok: true, tool, delivered: true, executed: 'no', data });
const tool = (id, name, input, data, extra = {}) => ({ type: 'tool_use', part: { id, callID: id, tool: `browser_${name}`, state: { status: 'completed', input, output: JSON.stringify({ ...outcome(name, data), ...extra }) } } });
const promptSummary = { type: 'text', part: { text: '에이전트 브라우저 / 12,000원 / a | b, c' } };
const fixture = { events: [{ type: 'search', body: { q: '합성 검색어', category: '도서' } }], submitCounts: {} };
const preflight = { initialized: true, toolsListed: true, browserConnected: true };
const steps = [
  tool('a', 'browser_tabs', { action: 'attach' }, { tab: { tabId: 1 } }),
  tool('b', 'browser_tabs', { action: 'new' }, { tab: { tabId: 2, url: 'http://127.0.0.1:8790/detail.html?id=1' } }),
  tool('c', 'browser_extract', { kind: 'table' }, { rows: [['이름', '에이전트 브라우저'], ['가격', '12,000원'], ['비고', 'a | b, c']] }),
  tool('d', 'browser_tabs', { action: 'switch', tabId: 1 }, { tab: { tabId: 1 } }),
  tool('e', 'browser_tabs', { action: 'release' }, { released: true }),
  promptSummary,
];
const score = (events, log = fixture, probe = preflight) => scoreRun({ events, fixtureLog: log, preflight: probe, exitCode: 0, query: '합성 검색어', category: '도서', fixtureUrl: 'http://127.0.0.1:8790' });

test('prose never establishes communication, tool execution or model success', () => {
  const result = score([promptSummary], fixture, {});
  assert.equal(result.communication.success, false);
  assert.equal(result.tools.success, false);
  assert.equal(result.model.success, false);
});

test('model success requires ordered new tab, actual table extraction, return and matching fixture log', () => {
  assert.equal(score(steps).model.success, true);
  assert.equal(score(steps.filter(e => e.part.callID !== 'd')).model.success, false);
  assert.equal(score(steps, { events: [] }).model.success, false);
  assert.equal(score([steps[0], steps[2], steps[1], ...steps.slice(3)]).model.success, false);
  assert.equal(score([...steps.slice(0, 4), tool('away', 'browser_tabs', { action: 'switch', tabId: 2 }, { tab: { tabId: 2 } }), ...steps.slice(4)]).model.success, false);
});

test('duplicate call events do not inflate counts and executed errors stay failures', () => {
  const result = score([steps[0], steps[0], ...steps.slice(1)]);
  assert.deepEqual(result.tools, { success: true, passed: 5, total: 5 });
  const bad = tool('bad', 'browser_click', {}, {}, { ok: false, executed: 'yes', error: { code: 'EXECUTION_UNKNOWN' } });
  assert.equal(score([...steps, bad]).tools.success, false);
});

test('quota, pricing evidence and unknown model costs halt subsequent runs', () => {
  assert.match(stopReason([{ type: 'error', error: { message: 'rate limit exceeded', statusCode: 429 } }]), /quota|rate/i);
  assert.match(stopReason([{ type: 'step_finish', part: { cost: 0.001 } }]), /cost/i);
  assert.equal(stopReason([{ type: 'step_finish', part: { cost: 0 } }]), null);
});


test('official pricing verification binds exact model ID to a free row and live availability', () => {
  const html = '<table><tr><td>Synthetic Free</td><td>synthetic-free</td><td>endpoint</td></tr></table>' +
    '<table><tr><td>Synthetic Free</td><td>Free</td><td>Free</td><td>Free</td><td>-</td></tr></table>';
  const live = { data: [{ id: 'synthetic-free' }] };
  assert.equal(verifyOfficialPricing(selected, html, live).modelName, 'Synthetic Free');
  assert.throws(() => verifyOfficialPricing(selected, html, { data: [] }), /available/);
  assert.throws(() => verifyOfficialPricing(selected, html.replace('<td>Free</td>', '<td>$1</td>'), live), /free/i);
  assert.throws(() => verifyOfficialPricing(selected, html.replace('synthetic-free</td>', 'another-free</td>'), live), /mapping/);
});

test('provider access denial and generic API failures retain an actionable stop reason', () => {
  const freeTier = { type: 'error', error: { name: 'APIError', data: { message: "OpenCode's free tier can only be used from within OpenCode", statusCode: 403, responseBody: JSON.stringify({ error: { type: 'FreeTierError' } }) } } };
  assert.match(stopReason([freeTier]), /Zen free-tier access denied.*403/i);
  assert.match(stopReason([{ type: 'error', error: { name: 'APIError', data: { message: 'Provider unavailable', statusCode: 503 } } }]), /API.*503/i);
  assert.match(stopReason([{ type: 'error', error: { name: 'APIError', data: { message: 'Unauthorized', statusCode: 401 } } }]), /access denied.*401/i);
  assert.match(stopReason([{ type: 'error', error: { name: 'APIError', data: { message: 'Provider failed', statusCode: 500, responseHeaders: { 'x-request-id': 'abc429xyz' } } } }]), /API.*500/i);
});
