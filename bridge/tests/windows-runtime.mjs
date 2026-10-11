// Run with native Windows Node and the existing tests/e2e ws dependency.
// Required: AGENT_BROWSER_TEST_EXE, AGENT_BROWSER_TEST_OPENCODE_EXE.
// WSL additionally requires AGENT_BROWSER_TEST_WSL_EXE and AGENT_BROWSER_TEST_WSL_NODE.
// RUNTIME_KIND is native, cmd, or wsl. No model request is made.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(process.env.AGENT_BROWSER_TEST_MODULE_ROOT || new URL('../../tests/e2e/package.json', import.meta.url));
const WebSocket = require('ws');
assert.equal(process.platform, 'win32', 'This verifies a native Windows process, not a Linux binary');
const exe = process.env.AGENT_BROWSER_TEST_EXE;
const openCode = process.env.AGENT_BROWSER_TEST_OPENCODE_EXE;
assert(exe && openCode, 'Explicit fixture executable paths are required');
const kind = process.env.RUNTIME_KIND || 'native';
const scenario = process.env.RUNTIME_SCENARIO || '';
let fixtureShutdown;
const home = mkdtempSync(join(tmpdir(), 'ab-runtime-한글 공간-'));
const directory = join(home, '작업 공간'); mkdirSync(directory);
const env = { ...process.env, AGENT_BROWSER_HOME: home };
execFileSync(exe, ['pair'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
const token = JSON.parse(readFileSync(join(home, 'config.json'))).token;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const windowsToWsl = path => '/mnt/' + path[0].toLowerCase() + path.slice(2).replaceAll('\\', '/');
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const port = await freePort();
let bridge, ws, sequence = 0;
const pending = new Map();
const outcome = { home, kind, checks: [] };
function launch() { bridge = spawn(exe, ['serve', '--port', String(port)], { env, stdio: 'ignore' }); }
function call(method, params = {}) {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 90_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ v: 1, type: 'req', id, method, params }));
  });
}
async function connect() {
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: 'chrome-extension://icgmjjcpnaenpfjfoggnaodeaidbnihl' });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      connected = true; break;
    } catch { await sleep(100); }
  }
  assert(connected, 'Fixture Bridge must start');
  ws.on('message', data => {
    const message = JSON.parse(data), request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.ok ? request.resolve(message.result) : request.reject(Error(message.error?.code + ': ' + message.error?.message));
  });
  const nonce = randomBytes(32).toString('hex'), role = 'extension', clientId = 'runtime-fixture';
  const challenge = await call('auth.hello', { role, clientId, clientNonce: nonce, authVersion: 1, repair: false });
  const transcript = JSON.stringify(['agent-browser-auth-v1', 'client', role, clientId, nonce, challenge.serverNonce, false]);
  await call('auth.prove', { authVersion: 1, proof: createHmac('sha256', token).update(transcript).digest('hex') });
}
const profile = {
  id: kind, name: 'Synthetic runtime fixture', kind: 'windows', directory, executable: openCode, port: await freePort(),
  env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ['fixture-preserved'], mcp: { fixture: { type: 'local', command: ['nonexistent-fixture'], enabled: false } } }) },
};
// The wrapper delegates serve/version to real OpenCode. Only attach uses a fixture
// which verifies argv and authenticates the same real backend without opening a TUI.
const attachFixture = join(home, 'attach-fixture.mjs');
writeFileSync(attachFixture, `import assert from 'node:assert/strict';
const [action,url,flag,directory] = process.argv.slice(2);
assert(action === 'attach' && flag === '--dir' && directory === process.env.ATTACH_EXPECTED_DIRECTORY, 'Structured attach arguments changed');
assert(process.env.OPENCODE_SERVER_PASSWORD, 'Attach credentials must be passed through the environment');
const auth = 'Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const response = await fetch(url+'/global/health',{headers:{Authorization:auth}});
assert(response.ok, 'Attach must authenticate the same managed backend');
assert((await response.json()).version.startsWith('1.'), 'Attach backend must be v1');
console.log('attach-fixture-authenticated');
`);
if (kind === 'cmd') {
  const launcher = join(home, '실행 도구.cmd');
  profile.env.ATTACH_FIXTURE_FILE = attachFixture; profile.env.ATTACH_FIXTURE_NODE = process.execPath;
  writeFileSync(launcher, `@echo off\r\nif "%~1"=="attach" (\r\n"%ATTACH_FIXTURE_NODE%" "%ATTACH_FIXTURE_FILE%" %*\r\nexit /b\r\n)\r\n"${openCode}" %*\r\n`);
  profile.executable = launcher;
} else if (kind === 'wsl') {
  assert(process.env.AGENT_BROWSER_TEST_WSL_EXE && process.env.AGENT_BROWSER_TEST_WSL_NODE, 'Explicit WSL fixture paths are required');
  const launcher = join(home, 'wsl-launcher.sh');
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  writeFileSync(launcher, `#!/bin/sh\nif [ "$1" = attach ]; then exec ${quote(process.env.AGENT_BROWSER_TEST_WSL_NODE)} ${quote(windowsToWsl(attachFixture))} "$@"; fi\nexec ${quote(process.env.AGENT_BROWSER_TEST_WSL_EXE)} "$@"\n`);
  profile.kind = 'wsl'; profile.distribution = process.env.AGENT_BROWSER_TEST_WSL_DISTRO || 'Ubuntu';
  profile.executable = windowsToWsl(launcher); profile.directory = '/tmp';
}
profile.env.ATTACH_EXPECTED_DIRECTORY = profile.directory;
async function regression() {
  if (scenario === 'healthy-fixture') {
    const file = join(home,'healthy-fixture.cjs');
    writeFileSync(file, readFileSync(new URL('./fixtures/opencode-server.cjs',import.meta.url),'utf8') + '\nsetTimeout(()=>process.exit(0),90000).unref();\n');
    if(kind === 'wsl') {
      const launcher = join(home,'healthy-fixture.sh');
      writeFileSync(launcher, `#!/bin/sh\nexec "${process.env.AGENT_BROWSER_TEST_WSL_NODE}" "${windowsToWsl(file)}" "$@"\n`);
      profile.executable = windowsToWsl(launcher); profile.directory='/tmp';
    } else {
      const launcher = join(home,'healthy-fixture.cmd');
      profile.env.AB_FIXTURE_NODE = process.execPath; profile.env.AB_FIXTURE_FILE = file;
      writeFileSync(launcher, '@echo off\r\n"%AB_FIXTURE_NODE%" "%AB_FIXTURE_FILE%" %*\r\n'); profile.executable = launcher;
    }
    await call('profile.save',{profile});
    const ready = await call('runtime.ensure',{profileId:profile.id}); assert.equal(ready.state,'ready',ready.error);
    const status = await call('runtime.status',{profileId:profile.id}); assert.equal(status.state,'ready');
    ws.close(); bridge.kill(); await sleep(400); launch(); await connect();
    assert.equal((await call('runtime.ensure',{profileId:profile.id})).baseUrl,ready.baseUrl);
    await call('runtime.stop',{profileId:profile.id});
    assert.equal(await fetch(ready.baseUrl+'/').then(()=>true,()=>false),false);
    await call('profile.delete',{profileId:profile.id}); outcome.checks.push('synthetic-ready-restart-reuse-stop');
  } else if (scenario === 'wsl-unknown-marker') {
    assert.equal(kind,'wsl'); profile.executable='/bin/true'; profile.directory='/tmp';
    await call('profile.save',{profile});
    const path=join(home,'runtime.json'), config=JSON.parse(readFileSync(path));
    config.runtimes[profile.id]={profileId:profile.id,instance:'missing-fixture',baseUrl:'http://127.0.0.1:'+profile.port,username:'opencode',password:'fixture',launcher:{pid:0,created:0,image:'absent'},server:null,wslOwnerFile:windowsToWsl(join(home,'missing.owner')),version:null};
    writeFileSync(path,JSON.stringify(config));
    assert.equal((await call('runtime.status',{profileId:profile.id})).state,'error','Unknown ownership is not stopped');
    await assert.rejects(call('runtime.stop',{profileId:profile.id}),/record was retained/);
    await assert.rejects(call('profile.delete',{profileId:profile.id}),/record was retained/);
    assert(JSON.parse(readFileSync(path)).runtimes[profile.id]);
    outcome.checks.push('R04-missing-marker-preserves-unknown-runtime');
  } else if (scenario === 'health-failure') {
    assert.equal(kind, 'cmd');
    const file = join(home, 'bad-health.mjs'), launcher = join(home, 'bad-health.cmd'), nonce = randomBytes(16).toString('hex');
    writeFileSync(file, `import {createServer} from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port')+1]);
const server = createServer((req,res) => { res.writeHead(503); res.end('synthetic unhealthy'); if(req.url === '/stop/${nonce}') server.close(); });
server.listen(port,'127.0.0.1'); setTimeout(()=>process.exit(0),90000).unref();`);
    profile.env.AB_FIXTURE_NODE = process.execPath; profile.env.AB_FIXTURE_FILE = file;
      writeFileSync(launcher, '@echo off\r\n"%AB_FIXTURE_NODE%" "%AB_FIXTURE_FILE%" %*\r\n');
    profile.executable = launcher;
    fixtureShutdown = () => fetch(`http://127.0.0.1:${profile.port}/stop/${nonce}`).catch(()=>{});
    await call('profile.save', {profile});
    const ready = call('runtime.ensure', {profileId:profile.id});
    let recordedChild = false, listening = false;
    for(let i=0;i<80;i++) {
      await sleep(100);
      listening ||= await fetch(`http://127.0.0.1:${profile.port}/`).then(()=>true,()=>false);
      try { if(JSON.parse(readFileSync(join(home,'runtime.json'))).runtimes[profile.id]?.server) recordedChild=true; } catch {}
      if(listening && recordedChild) break;
    }
    const result = await ready;
    assert.equal(result.state,'error');
    const alive = await fetch(`http://127.0.0.1:${profile.port}/`).then(()=>true,()=>false);
    outcome.observed = {listening, recordedChild, aliveAfterFailure:alive};
    assert(listening, 'Synthetic .cmd fixture never opened its listener');
    assert(recordedChild, 'R03 verified .cmd child listener was not persisted before health failed');
    assert.equal(alive,false,'R03 failed ensure left the synthetic child server listening');
    assert(!JSON.parse(readFileSync(join(home,'runtime.json'))).runtimes[profile.id]);
    outcome.checks.push('R03-unhealthy-cmd-child-recorded-and-terminated');
  } else if (scenario === 'wsl-start-failure') {
    assert.equal(kind,'wsl'); profile.executable = '/bin/true'; profile.directory = '/nonexistent-agent-browser-' + randomBytes(10).toString('hex');
    await call('profile.save',{profile});
    assert.equal((await call('runtime.ensure',{profileId:profile.id})).state,'error');
    await call('runtime.stop',{profileId:profile.id});
    assert(!JSON.parse(readFileSync(join(home,'runtime.json'))).runtimes[profile.id], 'R04 failed WSL launch retained its ownership record');
    await call('profile.save',{profile:{...profile,name:'Editable after failed start'}});
    await call('profile.delete',{profileId:profile.id});
    outcome.checks.push('R04-wsl-invalid-directory-stop-edit-delete');
  } else if (scenario === 'doctor-env') {
    profile.env.AB_DOCTOR_FIXTURE = 'fixture-env-present';
    if(kind === 'wsl') {
      const file = join(home,'version-env.sh');
      writeFileSync(file, `#!/bin/sh\n[ "$AB_DOCTOR_FIXTURE" = fixture-env-present ] && [ "$PWD" = "$AB_DOCTOR_DIRECTORY" ] || exit 1\nprintf '1.18.29\\n'\n`);
      profile.executable = windowsToWsl(file); profile.directory = '/tmp';
    } else {
      const file = join(home,'version-env.cmd');
      writeFileSync(file, '@echo off\r\nif not "%AB_DOCTOR_FIXTURE%"=="fixture-env-present" exit /b 1\r\nif not "%CD%"=="%AB_DOCTOR_DIRECTORY%" exit /b 1\r\necho 1.18.29\r\n');
      profile.executable = file;
    }
    profile.env.AB_DOCTOR_DIRECTORY = profile.directory;
    await call('profile.save',{profile});
    const result = await call('doctor.run',{profileId:profile.id});
    assert(result.checks.some(check => check.id === 'executable' && check.status === 'ok'), 'D01 doctor must use the profile environment and working directory');
    await call('profile.delete',{profileId:profile.id}); outcome.checks.push('D01-profile-environment-and-directory');
  } else throw Error('Unknown regression scenario');
}
try {
  launch(); await connect();
  if (scenario) { await regression(); outcome.ok = true; } else {
  const started = JSON.parse(execFileSync(exe, ['--home', home, 'start', '--port', String(port)], { env: process.env, timeout: 20_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(started.running && started.port === port);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'))).port, port);
  await call('profile.save', { profile, makeDefault: true });
  const cliReady = JSON.parse(execFileSync(exe, ['--home', home, 'runtime', 'start', '--profile', profile.id], { env: process.env, timeout: 75_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(cliReady.state === 'ready' && !('password' in cliReady) && !('username' in cliReady));
  outcome.checks.push('custom-start-persists-port-and-cli-runtime-start-redacts-credentials');
  const [first, concurrent] = await Promise.all([call('runtime.ensure', { profileId: profile.id }), call('runtime.ensure', { profileId: profile.id })]);
  assert(first.state === 'ready', first.error || 'Runtime must become ready');
  assert(first.baseUrl === concurrent.baseUrl && first.password === concurrent.password, 'Concurrent ensure must share one runtime');
  outcome.checks.push('concurrent-ensure-shares-one-runtime');
  const doctor = await call('doctor.run', { profileId: profile.id });
  for (const id of ['bridge', 'extension', 'executable', 'opencode', 'mcp']) assert(doctor.checks.some(check => check.id === id && check.status === 'ok'), `${id} diagnostic must be okay`);
  assert(doctor.checks.some(check => check.id === 'model' && check.inferenceTested === false));
  assert(!JSON.stringify(doctor).includes(first.password));
  outcome.checks.push('doctor-authenticated-bridge-extension-executable-mcp-model-metadata-no-inference');
  const auth = 'Basic ' + Buffer.from(first.username + ':' + first.password).toString('base64');
  const config = await fetch(first.baseUrl + '/config?directory=' + encodeURIComponent(profile.directory), { headers: { Authorization: auth } }).then(response => response.json());
  assert(config.instructions.includes('fixture-preserved') && config.mcp.fixture && config.mcp.browser);
  assert.equal(config.mcp.browser.environment.AGENT_BROWSER_PORT, String(port));
  outcome.checks.push('overlay-preserves-settings-and-actual-port');
  if (kind !== 'native') {
    const output = execFileSync(exe, ['--home', home, 'attach', '--profile', profile.id], { env: process.env, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert(output.includes('attach-fixture-authenticated')); outcome.checks.push('attach-argv-environment-authenticates-same-server');
  }
  const [again, status] = await Promise.all([call('runtime.ensure', { profileId: profile.id }), call('runtime.status', { profileId: profile.id }), call('heartbeat')]);
  assert(first.baseUrl === again.baseUrl && !('password' in status)); outcome.checks.push('reuse-status-redaction-heartbeat');
  ws.close(); bridge.kill(); await sleep(400); launch(); await connect();
  const restarted = await call('runtime.ensure', { profileId: profile.id });
  assert(restarted.baseUrl === first.baseUrl && restarted.password === first.password, 'Bridge restart must reuse its owned server');
  outcome.checks.push('bridge-restart-reuses-owned-server');
  const stopped = JSON.parse(execFileSync(exe, ['--home', home, 'runtime', 'stop-all', '--json'], { env: process.env, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(stopped.stoppedProfiles, [profile.id]); assert.deepEqual(stopped.errors, []);
  assert.equal((await call('runtime.status', { profileId: profile.id })).state, 'stopped');
  outcome.checks.push('cli-stop-all-owned-runtime-confirmed-stopped'); await call('profile.delete', { profileId: profile.id }); outcome.ok = true;
  }
} catch (error) {
  outcome.error = error.message;
  try { await call('runtime.stop', { profileId: profile.id }); } catch { outcome.cleanup = 'Runtime ownership record was retained in the isolated home'; }
} finally { await fixtureShutdown?.(); ws?.close(); bridge?.kill(); }
writeFileSync(join(home, 'result.json'), JSON.stringify(outcome, null, 2));
console.log(JSON.stringify(outcome)); process.exitCode = outcome.ok ? 0 : 1;
