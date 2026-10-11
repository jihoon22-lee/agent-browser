// Deterministic v1 API contract check. Native Node 24: --experimental-transform-types.
// The synthetic provider can only return an error; zero provider requests is asserted.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { crc32, deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { isolatedEnvironment } from '../agent/runner-lib.mjs';
import { OpenCodeV1Client } from '../../extension/src/agents/opencode-v1/client.ts';

const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2), exe = args[args.indexOf('--opencode') + 1] || join(homedir(), '.opencode', 'bin', 'opencode');
const output = new URL('../agent/results/api-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '/', import.meta.url);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'AgentBrowser-api-한글 ')), workspace = join(root, 'workspace');
await mkdir(workspace);
let providerRequests = 0;
const provider = createServer((req, res) => { providerRequests++; res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"No model calls allowed in API verification"}'); });
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const socket = createSocket(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const password = randomBytes(24).toString('hex'), configPath = join(root, 'opencode.json');
const config = { enabled_providers: ['fixture'], provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic API fixture', whitelist: ['fixture'], options: { baseURL: 'http://127.0.0.1:' + provider.address().port + '/v1', apiKey: 'synthetic-not-a-secret' }, models: { fixture: { name: 'Synthetic fixture', limit: { context: 4096, output: 512 }, cost: { input: 0, output: 0 } }, hidden: { name: 'Must be excluded by whitelist' } } } }, model: 'fixture/fixture', small_model: 'fixture/fixture', plugin: [], instructions: [], mcp: {}, snapshot: false, autoupdate: false, share: 'disabled', command: { fixture: { template: 'Synthetic command; never run in this verification.', description: 'Fixture only' } } };
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
const env = { ...isolatedEnvironment(process.env, root, configPath), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' };
for (const key of ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'OPENCODE_TEST_MANAGED_CONFIG_DIR']) await mkdir(env[key], { recursive: true });
await writeFile(join(workspace, '합성 파일.txt'), '실행 환경 독립 첨부 fixture');
const summary = { platform: process.platform, startedAt: new Date().toISOString(), success: false, checks: {}, llmCalls: 0 };
let child, stderr = '', sessions = [], client, eventController, eventStream;
const phase = text => console.log('API contract: ' + text);
try {
  const version = (await exec(exe, ['--version'], { env, cwd: workspace })).stdout.trim(); assert.equal(version, '1.18.29'); summary.version = version;
  child = spawn(exe, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
  const origin = 'http://127.0.0.1:' + port;
  client = new OpenCodeV1Client({ baseUrl: origin, directory: workspace, username: 'opencode', password });
  phase('health/authentication');
  let health;
  for (let i = 0; i < 300; i++) { try { health = await client.get('/global/health'); break; } catch { if (child.exitCode !== null) throw Error('OpenCode exited before readiness'); await wait(100); } }
  assert.equal(health?.healthy, true); summary.checks.health = true;
  assert.equal((await fetch(origin + '/global/health')).status, 401); summary.checks.authentication = true;
  phase('configured providers');
  const catalog = await client.get('/provider'), configured = await client.get('/config/providers');
  const fixture = catalog.all.find(provider => provider.id === 'fixture');
  assert.deepEqual(catalog.connected, ['fixture']); assert.deepEqual(Object.keys(fixture.models), ['fixture']);
  assert.equal(configured.providers.some(provider => provider.id === 'fixture'), true);
  summary.checks.configuredModelFiltering = { connected: catalog.connected, models: Object.keys(fixture.models) };
  phase('agents, commands, skills');
  assert.ok((await client.get('/agent')).some(agent => agent.name === 'build'));
  assert.ok((await client.get('/command')).some(command => command.name === 'fixture' && command.source === 'command'));
  assert.ok(Array.isArray(await client.get('/skill'))); summary.checks.agentsCommandsSkills = true;
  phase('pending cards');
  assert.deepEqual(await client.get('/question'), []); assert.deepEqual(await client.get('/permission'), []);
  for (const [path, body] of [['/question/que_missing/reply', { answers: [['예']] }], ['/permission/per_missing/reply', { reply: 'reject' }]]) {
    await assert.rejects(client.post(path, body), error => error.status === 404);
  }
  summary.checks.pendingCardsAndStaleReplies = true;
  phase('session lifecycle');
  const session = await client.post('/session', { title: '합성 세션', model: { id: 'fixture', providerID: 'fixture' } }); sessions.push(session.id);
  assert.equal(session.title, '합성 세션');
  assert.equal((await client.patch('/session/' + session.id, { title: '이름 변경됨' })).title, '이름 변경됨');
  assert.ok((await client.get('/session', { search: '이름 변경됨' })).some(value => value.id === session.id)); summary.checks.sessionCrudSearch = true;
  phase('SSE and no-reply attachments');
  const events = []; eventController = new AbortController(); let connected = false, streamError;
  eventStream = client.events(event => events.push(event), value => { connected = value; }, eventController.signal).catch(error => { streamError = error; });
  for (let i = 0; i < 500 && !connected && !streamError; i++) await wait(20);
  if (streamError) throw streamError;
  assert.equal(connected, true, 'Authenticated SSE startup timeout');
  const file = { type: 'file', mime: 'text/plain', filename: '업로드 한글.txt', url: 'data:text/plain;base64,' + Buffer.from('한글 첨부 데이터').toString('base64') };
  const pngChunk = (type, bytes) => { const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([name, bytes]))); return Buffer.concat([size, name, bytes, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0,0,0,0,255]))), pngChunk('IEND', Buffer.alloc(0))]);
  const image = { type: 'file', mime: 'image/png', filename: '합성 픽셀.png', url: 'data:image/png;base64,' + png.toString('base64') };
  const response = await client.post('/session/' + session.id + '/message', { noReply: true, agent: 'build', model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: '모델을 호출하지 않는 합성 입력' }, file, image] });
  const records = await client.get('/session/' + session.id + '/message');
  assert.equal(records.length, 1); assert.equal(records[0].info.role, 'user');
  assert.ok(JSON.stringify(records[0].parts).includes('한글 첨부 데이터'));
  assert.ok(JSON.stringify(records[0].parts).includes('업로드 한글.txt'));
  assert.ok(records[0].parts.some(part => part.type === 'file' && part.mime === 'image/png'));
  summary.checks.dataUrlAttachmentNoReply = { textStored: true, imageStored: true, responseRole: response.info.role };
  await client.post('/session/' + session.id + '/prompt_async', { noReply: true, agent: 'build', model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: '비동기 입력' }] });
  for (let i = 0; i < 100 && !events.some(event => event.type === 'message.updated'); i++) await wait(20);
  eventController.abort(); await eventStream;
  assert.ok(events.some(event => event.type === 'message.updated'));
  summary.checks.authenticatedSse = { types: [...new Set(events.map(event => event.type))] };
  assert.ok(Array.isArray(await client.get('/session/' + session.id + '/todo')));
  assert.ok(Array.isArray(await client.get('/session/' + session.id + '/children')));
  assert.ok(Array.isArray(await client.get('/session/' + session.id + '/diff')));
  assert.equal(await client.post('/session/' + session.id + '/abort'), true);
  const fork = await client.post('/session/' + session.id + '/fork', { messageID: records[0].info.id }); sessions.push(fork.id); assert.notEqual(fork.id, session.id); assert.match(fork.title, /fork/);
  await client.post('/session/' + session.id + '/revert', { messageID: records[0].info.id });
  await client.post('/session/' + session.id + '/unrevert'); summary.checks.forkAbortRevertDiff = true;
  const fileSearch = await client.get('/find/file', { query: '합성', type: 'file' });
  summary.checks.fileSearchResults = fileSearch;
  summary.checks.fileListResults = await client.get('/file', {path:''});
  summary.checks.fileContentResult = await client.get('/file/content', { path:'합성 파일.txt' });
  const completed = await client.findFiles('합성'); summary.checks.fileAutocomplete = completed;
  assert.ok(completed.some(path => path.replaceAll('\\', '/').split('/').at(-1) === '합성 파일.txt'), 'Server file completion must find the synthetic file: ' + JSON.stringify(completed));
  assert.ok(JSON.stringify(await client.get('/file/content', { path: '합성 파일.txt' })).includes('실행 환경 독립')); summary.checks.fileReferences = true;
  assert.equal(providerRequests, 0); summary.success = true;
} catch (error) { summary.error = error.message; process.exitCode = 1; }
finally {
  eventController?.abort();
  await eventStream;
  if (client) for (const id of sessions) await client.delete('/session/' + id).catch(() => {});
  if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await Promise.race([exit, wait(5000)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  await new Promise(resolve => provider.close(resolve));
  summary.llmCalls = providerRequests;
  if (providerRequests) { summary.success = false; summary.error = 'A forbidden synthetic provider request was attempted'; process.exitCode = 1; }
  summary.finishedAt = new Date().toISOString();
  await writeFile(new URL('summary.json', output), JSON.stringify(summary, null, 2));
  await writeFile(new URL('stderr.log', output), stderr.replaceAll(password, '[REDACTED]'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(JSON.stringify(summary, null, 2));
}
