#!/usr/bin/env node
// Run with native Windows Node. Uses only built-in modules and starts no LLM request.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { isolatedEnvironment } from './runner-lib.mjs';

const exec = promisify(execFile);
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const jsonFile = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
async function ephemeralPort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolveListen); });
  const port = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close(error => error ? reject(error) : resolveClose()));
  return port;
}
function beforeDeadline(promise, ms) {
  return new Promise(resolveValue => {
    const timer = setTimeout(() => resolveValue(null), ms);
    promise.then(value => { clearTimeout(timer); resolveValue(value); });
  });
}

async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { terminated: false, exited: true };
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  child.kill();
  const result = await beforeDeadline(exited, 5000);
  if (result) return { terminated: true, exited: true, ...result };
  child.kill('SIGKILL');
  const final = await beforeDeadline(exited, 3000);
  return { terminated: true, exited: final !== null, ...final };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This verification must run in native Windows Node, not WSL Node.');
  const values = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--exe', '--reference', '--output'].includes(key) || !value) throw new Error('Usage: node check-native.mjs --exe C:\\...\\opencode.exe [--reference openapi.json] [--output directory]');
    values[key] = value;
  }
  if (!values['--exe']) throw new Error('An explicit --exe path is required.');
  const executable = resolve(values['--exe']);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const output = resolve(values['--output'] ?? fileURLToPath(new URL('./results/native-' + stamp + '/', import.meta.url)));
  const referencePath = resolve(values['--reference'] ?? fileURLToPath(new URL('../../docs/reference/opencode-1.18.29-openapi.json', import.meta.url)));
  await mkdir(output, { recursive: true });
  const runtime = await mkdtemp(join(tmpdir(), 'agent-browser-native-check-'));
  const workspace = join(runtime, 'workspace'), configPath = join(runtime, 'opencode.json');
  const config = { $schema: 'https://opencode.ai/config.json', enabled_providers: [], plugin: [], instructions: [], mcp: {}, tools: { '*': false }, permission: { '*': 'deny' }, formatter: false, lsp: false, snapshot: false, autoupdate: false, share: 'disabled' };
  await mkdir(workspace, { recursive: true });
  await jsonFile(configPath, config);
  const env = isolatedEnvironment(process.env, runtime, configPath);
  for (const key of ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'OPENCODE_TEST_MANAGED_CONFIG_DIR']) await mkdir(env[key], { recursive: true });
  const summary = { startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, nodeVersion: process.version, executable, runtime, workspace, output, referencePath, llmCalls: 0, v2OperationsExecuted: 0, success: false };
  let child, stdout = '', stderr = '', spawnError;
  try {
    summary.executableSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
    const cli = async args => (await exec(executable, args, { env, cwd: workspace, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true })).stdout;
    summary.version = (await cli(['--version'])).trim();
    if (summary.version !== '1.18.29') throw new Error('Expected OpenCode 1.18.29, got ' + summary.version);
    const actualConfig = JSON.parse(await cli(['debug', 'config', '--pure']));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const key of ['enabled_providers', 'plugin', 'instructions', 'mcp', 'tools', 'permission', 'formatter', 'lsp', 'snapshot', 'autoupdate', 'share']) {
      if (!same(actualConfig[key], config[key])) throw new Error('Resolved config is not isolated: ' + key);
    }
    summary.configIsolated = true;
    await jsonFile(join(output, 'resolved-config.json'), actualConfig);
    const port = await ephemeralPort();
    summary.requestedPort = port;
    child = spawn(executable, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    summary.serverPid = child.pid;
    child.on('error', error => { spawnError = error; });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1024 * 1024); });
    let origin;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native serve exited before its listening address was available.');
      const match = (stdout + '\n' + stderr).match(/https?:\/\/127\.0\.0\.1:(\d+)/);
      if (match && Number(match[1]) > 0) {
        if (Number(match[1]) !== port) throw new Error('Native server reported a port other than the isolated requested port.');
        origin = 'http://127.0.0.1:' + match[1]; break; }
      await delay(100);
    }
    if (!origin) throw new Error('Native serve did not report a random localhost port within 60 seconds.');
    summary.origin = origin;
    const fetchJson = async path => {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status);
      return response.json();
    };
    summary.health = await fetchJson('/global/health');
    if (summary.health.healthy !== true || summary.health.version !== '1.18.29') throw new Error('Native v1 health response did not match version 1.18.29.');
    const doc = await fetchJson('/doc'), reference = JSON.parse(await readFile(referencePath, 'utf8'));
    const paths = Object.keys(doc.paths ?? {}).sort(), expected = Object.keys(reference.paths ?? {}).sort();
    const missing = expected.filter(path => !paths.includes(path)), added = paths.filter(path => !expected.includes(path));
    const operations = value => Object.entries(value.paths ?? {}).flatMap(([path, item]) => Object.keys(item).filter(method => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)).map(method => method.toUpperCase() + ' ' + path)).sort();
    const actualOperations = operations(doc), expectedOperations = operations(reference);
    summary.openapi = { paths: paths.length, expectedPaths: expected.length, pathSetEqual: missing.length === 0 && added.length === 0, missing, added,
      operations: actualOperations.length, expectedOperations: expectedOperations.length, operationSetEqual: same(actualOperations, expectedOperations),
      v1Paths: paths.filter(path => !path.startsWith('/api/')).length, v2PathsPresentInDocument: paths.filter(path => path.startsWith('/api/')).length };
    await jsonFile(join(output, 'native-openapi.json'), doc);
    await jsonFile(join(output, 'path-set.json'), paths);
    if (!summary.openapi.pathSetEqual || !summary.openapi.operationSetEqual) throw new Error('Native OpenAPI path or operation set differs from the stored 1.18.29 reference.');
    summary.success = true;
  } catch (error) {
    summary.error = error.message;
    process.exitCode = 1;
  } finally {
    summary.serverCleanup = await stopOwned(child);
    if (!summary.serverCleanup.exited) { summary.success = false; summary.error ??= 'Own server process did not exit during cleanup.'; process.exitCode = 1; }
    summary.finishedAt = new Date().toISOString();
    await Promise.all([jsonFile(join(output, 'summary.json'), summary), writeFile(join(output, 'serve.stdout.log'), stdout), writeFile(join(output, 'serve.stderr.log'), stderr)]);
    console.log(JSON.stringify(summary, null, 2));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
