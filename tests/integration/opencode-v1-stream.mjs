// Real installed OpenCode v1 -> SSE -> product client/reducer, with a local deterministic provider.
// Run with Node 24 --experimental-transform-types. No real provider credentials or LLM calls.
import { spawn, execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from '../agent/runner-lib.mjs';
import { OpenCodeV1Client } from '../../extension/src/agents/opencode-v1/client.ts';
import { initialWorkbench, workbenchReducer } from '../../extension/src/sidepanel/workbench-state.ts';

const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const { values } = parseArgs({ options: { opencode: { type: 'string' }, 'timeout-ms': { type: 'string', default: '20000' } } });
const executable = values.opencode || join(homedir(), '.opencode', 'bin', 'opencode');
const timeoutMs = Number(values['timeout-ms']);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000);
const output = new URL('../agent/results/stream-' + new Date().toISOString().replace(/[:.]/g, '-') + process.pid + '/', import.meta.url);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'AgentBrowser-stream-한글 ')), workspace = join(root, 'workspace');
await mkdir(workspace);
const chunks = ['첫째 ', '둘째 ', '완료.'], expectedText = chunks.join('');
const begunAt = performance.now();
const summary = { httpRequests: [], phaseTimesMs: {}, platform: process.platform, startedAt: new Date().toISOString(), success: false, realLLMCalls: 0, syntheticProviderRequests: 0, checks: {}, providerRequests: [], wireEvents: [], clientEvents: [] };
let promptAt, providerFinishedAt, firstVisibleAt, completedVisibleAt, sessionID;
let state = initialWorkbench, child, client, eventController, eventStream, streamError, streamConnected = false;
let stderr = '', wireError;
const wireReaders = new Set();
const elapsed = () => promptAt === undefined ? null : Math.round(performance.now() - promptAt);
function eventMetadata(event) {
  const p = event.properties ?? {}, part = p.part, info = p.info;
  return {
    atMs: elapsed(), type: event.type, eventID: event.id ?? null,
    sessionID: p.sessionID ?? info?.sessionID ?? part?.sessionID ?? null,
    messageID: p.messageID ?? info?.id ?? part?.messageID ?? null,
    partID: p.partID ?? part?.id ?? null, partType: part?.type ?? null,
    role: info?.role ?? null, completed: typeof info?.time?.completed === 'number',
    textLength: typeof part?.text === 'string' ? part.text.length : null,
    field: p.field ?? null, deltaLength: typeof p.delta === 'string' ? p.delta.length : null,
    propertyKeys: Object.keys(p).sort(),
  };
}
function visible() {
  const assistants = (state.messages[sessionID] ?? []).filter(message => message.info.role === 'assistant');
  const text = assistants.flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text ?? '')).join('');
  return { text, completed: assistants.some(message => typeof message.info.time?.completed === 'number'), assistants: assistants.length };
}
async function readWire(body) {
  const reader = body.getReader(), decoder = new TextDecoder(); wireReaders.add(reader);
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw Error('Synthetic SSE frame exceeded limit');
      for (;;) {
        const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer); if (!boundary) break;
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) summary.wireEvents.push(eventMetadata(JSON.parse(data)));
      }
    }
  } catch (error) { if (!eventController?.signal.aborted) wireError = error.message; }
  finally { wireReaders.delete(reader); reader.releaseLock(); }
}
const recordingFetch = async (input, init) => {
  const began = performance.now();
  const response = await fetch(input, init);
  summary.httpRequests.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET', status: response.status, durationMs: Math.round(performance.now() - began), atMs: elapsed() });
  if (new URL(String(input)).pathname === '/event' && response.ok && response.body) {
    const [wire, application] = response.body.tee(); void readWire(wire);
    return new Response(application, { status: response.status, headers: response.headers });
  }
  return response;
};

const provider = createServer(async (req, res) => {
  summary.syntheticProviderRequests++;
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body || '{}');
  summary.providerRequests.push({ path: req.url, method: req.method, model: request.model, stream: request.stream, atMs: elapsed(), messageCount: request.messages?.length ?? 0 });
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || request.model !== 'fixture' || request.stream !== true || summary.syntheticProviderRequests !== 1) {
    res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Only one synthetic streamed chat request is allowed"}}'); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders();
  const send = (delta, finish_reason = null, usage) => res.write('data: ' + JSON.stringify({ id: 'chatcmpl-synthetic-stream', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n');
  for (const [index, content] of chunks.entries()) {
    await wait(300); if (res.destroyed) return;
    send(index === 0 ? { role: 'assistant', content } : { content });
  }
  await wait(300); if (res.destroyed) return;
  send({}, 'stop', { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  res.end('data: [DONE]\n\n'); providerFinishedAt = elapsed();
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const socket = createSocket(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const password = randomBytes(24).toString('hex'), configPath = join(root, 'opencode.json');
const fixtureModel = 'fixture/fixture';
const config = {
  enabled_providers: ['fixture'],
  provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic streaming fixture', whitelist: ['fixture'], options: { baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1', apiKey: 'synthetic-not-a-secret' }, models: { fixture: { name: 'Synthetic fixture', limit: { context: 4096, output: 512 }, cost: { input: 0, output: 0 } } } } },
  model: fixtureModel, small_model: fixtureModel, default_agent: 'stream-fixture', subagent_depth: 0,
  plugin: [], instructions: [], mcp: {}, tools: { '*': false }, permission: { '*': 'deny' },
  snapshot: false, formatter: false, lsp: false, compaction: { auto: false, prune: false }, autoupdate: false, share: 'disabled',
  agent: {
    'stream-fixture': { model: fixtureModel, mode: 'primary', prompt: 'Return the local synthetic response; do not use tools.', permission: { '*': 'deny' } },
    ...Object.fromEntries(['build', 'plan', 'title', 'summary', 'compaction'].map(name => [name, { model: fixtureModel }])),
    general: { model: fixtureModel, disable: true }, explore: { model: fixtureModel, disable: true },
  },
};
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const env = { ...isolatedEnvironment(process.env, root, configPath), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' };
// The fixture needs only loopback traffic; do not forward inherited proxy credentials.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
env.NO_PROXY = '127.0.0.1,localhost,::1';
for (const key of ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'OPENCODE_TEST_MANAGED_CONFIG_DIR']) await mkdir(env[key], { recursive: true });
try {
  const version = (await exec(executable, ['--version'], { env, cwd: workspace })).stdout.trim(); assert.equal(version, '1.18.29'); summary.version = version; summary.phaseTimesMs.version = Math.round(performance.now() - begunAt);
  child = spawn(executable, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
  client = new OpenCodeV1Client({ baseUrl: 'http://127.0.0.1:' + port, directory: workspace, username: 'opencode', password }, recordingFetch);
  let health;
  for (let i = 0; i < 300; i++) { try { health = await client.get('/global/health'); break; } catch { if (child.exitCode !== null) throw Error('Isolated OpenCode exited before readiness'); await wait(100); } }
  assert.equal(health?.healthy, true); summary.checks.health = true; summary.phaseTimesMs.health = Math.round(performance.now() - begunAt);
  const catalog = await client.get('/provider');
  assert.deepEqual(catalog.connected, ['fixture']); assert.deepEqual(Object.keys(catalog.all.find(value => value.id === 'fixture').models), ['fixture']);
  summary.checks.onlyFixtureProvider = true; summary.phaseTimesMs.catalog = Math.round(performance.now() - begunAt);
  const session = await client.post('/session', { title: 'Synthetic stream contract', model: { id: 'fixture', providerID: 'fixture' } }); sessionID = session.id;
  eventController = new AbortController();
  eventStream = client.events(event => {
    summary.clientEvents.push(eventMetadata(event));
    state = workbenchReducer(state, { type: 'event', event });
    const current = visible();
    if (current.text.length > 0 && firstVisibleAt === undefined) firstVisibleAt = elapsed();
    if (current.completed && current.text === expectedText && completedVisibleAt === undefined) completedVisibleAt = elapsed();
  }, connected => { streamConnected = connected; }, eventController.signal).catch(error => { streamError = error.message; });
  for (let i = 0; i < 500 && !streamConnected && !streamError; i++) await wait(20);
  assert.equal(streamConnected, true, streamError || 'SSE connection timeout');
  summary.phaseTimesMs.subscribed = Math.round(performance.now() - begunAt);
  promptAt = performance.now();
  await client.post('/session/' + sessionID + '/prompt_async', { messageID: 'msg_' + randomBytes(16).toString('hex'), agent: 'stream-fixture', model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'Return the deterministic local stream fixture.' }] });
  summary.phaseTimesMs.promptReturned = elapsed();
  for (const deadline = performance.now() + timeoutMs; performance.now() < deadline && completedVisibleAt === undefined && !streamError; ) await wait(25);
  const result = visible();
  summary.checks.reducer = { assistantCount: result.assistants, textLength: result.text.length, expectedTextLength: expectedText.length, textMatches: result.text === expectedText, completed: result.completed, firstVisibleAtMs: firstVisibleAt ?? null, completedVisibleAtMs: completedVisibleAt ?? null, providerFinishedAtMs: providerFinishedAt ?? null, visibleBeforeProviderFinished: firstVisibleAt !== undefined && firstVisibleAt < providerFinishedAt, abortRequests: 0, manualResyncs: 0 };
  // A final read diagnoses loss; it is never fed into the reducer or used to make the assertion pass.
  const stored = await client.get('/session/' + sessionID + '/message');
  const storedAssistants = stored.filter(message => message.info.role === 'assistant');
  summary.checks.serverStorage = { assistantCount: storedAssistants.length, completedCount: storedAssistants.filter(message => typeof message.info.time?.completed === 'number').length, textMatches: storedAssistants.flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('') === expectedText };
  assert.equal(summary.syntheticProviderRequests, 1, 'Only one local synthetic provider request was expected');
  assert.equal(streamError, undefined); assert.equal(wireError, undefined);
  assert.ok(result.text === expectedText, 'SSE alone must display the full assistant response without Stop or resync');
  assert.equal(result.completed, true, 'SSE alone must publish completed assistant state');
  assert.equal(result.assistants, storedAssistants.length, 'Non-message SSE events must not create phantom assistant messages');
  assert.equal(summary.checks.reducer.visibleBeforeProviderFinished, true, 'The first text chunk must be visible before provider completion');
  summary.success = true;
} catch (error) { summary.error = error.message.replaceAll(password, '[REDACTED]'); process.exitCode = 1; }
finally {
  eventController?.abort();
  await Promise.allSettled([...wireReaders].map(reader => reader.cancel()));
  await eventStream;
  summary.phaseTimesMs.cleanupStarted = Math.round(performance.now() - begunAt);
  if (client && sessionID) await client.request('DELETE', '/session/' + sessionID, { timeoutMs: 5000 }).catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, wait(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, wait(5000)]); }
  }
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  summary.finishedAt = new Date().toISOString(); summary.stderrBytes = Buffer.byteLength(stderr);
  summary.wireEventTypes = [...new Set(summary.wireEvents.map(event => event.type))];
  summary.clientEventTypes = [...new Set(summary.clientEvents.map(event => event.type))];
  summary.uniqueWireEventIDs = new Set(summary.wireEvents.map(event => event.eventID).filter(Boolean)).size;
  await writeFile(new URL('summary.json', output), JSON.stringify(summary, null, 2));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(JSON.stringify(summary, null, 2));
}
