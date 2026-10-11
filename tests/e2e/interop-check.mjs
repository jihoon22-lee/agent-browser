#!/usr/bin/env node
// WSL -> actual Windows exe lifecycle verification. It never connects to a user Chrome profile.
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const execFile = promisify(execFileCallback);
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WINDOWS_NODE = '/mnt/c/Program Files/nodejs/node.exe';
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const expectedTools = ['browser_tabs', 'browser_snapshot', 'browser_navigate', 'browser_click', 'browser_fill', 'browser_select', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_extract', 'browser_screenshot'];
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const cleanText = text => String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function nativeJson(code, args = []) {
  const result = await execFile(WINDOWS_NODE, ['-e', code, ...args], { timeout: 10_000, maxBuffer: 1_000_000 });
  return JSON.parse(result.stdout.trim());
}
function powershellValue(value) {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}
async function psJson(script) {
  const source = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference = "Stop"; ' + script;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const result = await execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 15_000, maxBuffer: 1_000_000 });
  const text = result.stdout.replace(/^\uFEFF/, '').trim();
  return text ? JSON.parse(text) : null;
}
async function toWsl(path) { return (await execFile('wslpath', ['-u', path])).stdout.trim(); }
async function freeWindowsPort() {
  return nativeJson("const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>console.log(JSON.stringify(port)));});");
}
async function windowsPortOpen(port) {
  return nativeJson("const net=require('node:net');const s=net.connect(Number(process.argv[1]),'127.0.0.1');let done=false;function end(value){if(done)return;done=true;s.destroy();console.log(JSON.stringify(value));}s.on('connect',()=>end(true));s.on('error',()=>end(false));s.setTimeout(1000,()=>end(false));", [String(port)]);
}
async function processInfo(pid) {
  assert(Number.isInteger(pid) && pid > 0);
  return psJson(`$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { 'null' } else { @{pid=[int]$p.ProcessId; executablePath=$p.ExecutablePath; commandLine=$p.CommandLine; created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`);
}
async function ownedProcesses(executable) {
  return psJson(`$expected = ${powershellValue(executable)}; $items = @(Get-CimInstance Win32_Process -Filter "Name = 'browser-bridge.exe'" | Where-Object { $_.ExecutablePath -eq $expected } | ForEach-Object { @{pid=[int]$_.ProcessId; executablePath=$_.ExecutablePath; commandLine=$_.CommandLine; created=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $items -Compress`);
}
function verifyOwner(info, executable, role, port) {
  assert(info, 'Owned Windows process must exist');
  assert.equal(info.executablePath.toLowerCase(), executable.toLowerCase(), 'Never touch a different executable');
  const rolePattern = role === 'serve' ? new RegExp(`(?:^|\\s)serve\\s+--port\\s+${port}(?:\\s|$)`) : /(?:^|\s)mcp(?:\s|$)/;
  assert(rolePattern.test(info.commandLine), 'Process command line must match the owned role/port');
}
async function stopOwned(info, executable, role, port) {
  if (!info) return false;
  verifyOwner(info, executable, role, port);
  const expected = powershellValue(executable);
  const creation = powershellValue(info.created);
  const rolePattern = powershellValue(role === 'serve' ? `(?:^|\\s)serve\\s+--port\\s+${port}(?:\\s|$)` : '(?:^|\\s)mcp(?:\\s|$)');
  return psJson(`$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${info.pid}"; if ($null -eq $p) { 'false'; exit }; if ($p.ExecutablePath -ne (${expected}) -or $p.CreationDate.ToUniversalTime().ToString('o') -ne (${creation}) -or $p.CommandLine -notmatch (${rolePattern})) { throw 'Owned PID identity changed; refusing termination' }; Stop-Process -Id ${info.pid} -Force -ErrorAction Stop; 'true'`);
}
async function aclInfo(path) {
  return psJson(`$acl = Get-Acl -LiteralPath (${powershellValue(path)}); @{owner=$acl.Owner; inheritanceProtected=$acl.AreAccessRulesProtected; access=@($acl.Access | ForEach-Object { @{identity=$_.IdentityReference.Value; rights=$_.FileSystemRights.ToString(); type=$_.AccessControlType.ToString(); inherited=$_.IsInherited; inheritanceFlags=$_.InheritanceFlags.ToString(); propagationFlags=$_.PropagationFlags.ToString()} })} | ConvertTo-Json -Depth 5 -Compress`);
}

class McpSession {
  constructor(executable, env) {
    this.child = spawn(executable, ['mcp'], { env, stdio: 'pipe' });
    this.messages = []; this.invalidLines = []; this.stderr = ''; this.pending = new Map(); this.nextId = 0;
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => resolve({ code, signal })));
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('close', () => this.fail(new Error('MCP process closed')));
    this.child.stderr.on('data', chunk => { this.stderr += String(chunk); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); assert.equal(message.jsonrpc, '2.0'); }
      catch { this.invalidLines.push(line); this.fail(new Error('MCP stdout is not pure JSON-RPC')); return; }
      this.messages.push(message);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error('MCP returned a JSON-RPC error'));
      else pending.resolve(message.result);
    });
  }
  fail(error) { this.failure = error; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'interop-verification', version: '1' } });
    assert.equal(init.serverInfo.name, 'agent-browser');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await this.request('tools/list', {});
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), [...expectedTools].sort());
    const tabs = await this.request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
    const outcome = JSON.parse(tabs.content.find(part => part.type === 'text').text);
    assert.equal(outcome.error.code, 'BROWSER_DISCONNECTED'); // Intentionally no browser in this isolated home.
    return { serverInfo: init.serverInfo, protocolVersion: init.protocolVersion, toolCount: list.tools.length, browserDisconnectedAsExpected: true };
  }
  async close() {
    this.child.stdin.end();
    let timer;
    try {
      return await Promise.race([this.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP did not exit after stdin closed')), 5_000); })]);
    } finally { clearTimeout(timer); }
  }
}

export async function cleanupOwnedProcesses({ executable, port, home, query = ownedProcesses, readPid = () => readFile(join(home, 'serve.pid'), 'utf8'), stop = stopOwned, delay = sleep }) {
  const warnings = [], errors = [];
  let processes;
  try { processes = await query(executable); }
  catch (error) { return { ownedProcessesCleaned: false, cleanupErrors: [String(error.message)] }; }
  for (const process of processes) {
    const role = /(?:^|\s)serve(?:\s|$)/.test(process.commandLine) ? 'serve' : 'mcp';
    try {
      verifyOwner(process, executable, role, port);
      if (role === 'serve') {
        try {
          const pid = Number(String(await readPid()).trim());
          if (!Number.isInteger(pid) || pid !== process.pid) warnings.push('The isolated serve.pid is invalid or stale; cleanup used the unique copied executable, role, port and creation identity');
        } catch {
          warnings.push('The isolated serve.pid is unavailable; cleanup used the unique copied executable, role, port and creation identity');
        }
      }
      // stopOwned rechecks executable, role/port and creation time in the same Windows call
      // that terminates the PID. This is a unique run-owned binary, never a shared install.
      await stop(process, executable, role, port);
    } catch (error) { errors.push(String(error.message)); }
  }
  let remaining;
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      remaining = await query(executable);
      if (!remaining.length) break;
      await delay(100);
    }
  } catch (error) { errors.push(String(error.message)); }
  return { ownedProcessesCleaned: Array.isArray(remaining) && remaining.length === 0, ...(warnings.length ? { cleanupWarnings: warnings } : {}), ...(errors.length ? { cleanupErrors: errors } : {}) };
}

export async function finalizeEvidence({ evidence, resultDir, wslRoot, remove = rm, save = writeFile }) {
  evidence.finishedAt = new Date().toISOString();
  // Publish before cleanup, then publish its result as well. File-lock failures cannot erase evidence.
  await save(join(resultDir, 'summary.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  if (evidence.results.length > 0 && evidence.results.every(result => result.ownedProcessesCleaned)) {
    try {
      await remove(wslRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      evidence.temporaryHomesRemoved = true;
    } catch (error) {
      evidence.temporaryCleanupError = String(error.message);
      evidence.passed = false;
    }
  }
  await save(join(resultDir, 'summary.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
}

async function runCase({ label, sourceExe, nativeRoot, wslRoot, resultDir, unicode }) {
  const directory = unicode ? 'Agent Browser 테스트' : 'standard';
  const nativeExe = win32.join(nativeRoot, directory, 'browser-bridge.exe');
  const wslExe = join(wslRoot, directory, 'browser-bridge.exe');
  const nativeHome = win32.join(nativeRoot, directory, 'isolated home');
  const wslHome = join(wslRoot, directory, 'isolated home');
  await mkdir(dirname(wslExe), { recursive: true });
  await copyFile(sourceExe, wslExe);
  const sourceHash = sha256(await readFile(sourceExe));
  assert.equal(sha256(await readFile(wslExe)), sourceHash);
  const port = await freeWindowsPort();
  assert.equal(await windowsPortOpen(port), false);
  const shared = (process.env.WSLENV ?? '').split(':').filter(entry => entry && !/^AGENT_BROWSER_(HOME|PORT|LOG)(\/|$)/.test(entry));
  const env = { ...process.env, AGENT_BROWSER_HOME: nativeHome, AGENT_BROWSER_PORT: String(port), AGENT_BROWSER_LOG: 'info', WSLENV: [...shared, 'AGENT_BROWSER_HOME/w', 'AGENT_BROWSER_PORT/w', 'AGENT_BROWSER_LOG/w'].join(':') };
  const record = { label, executable: nativeExe, binarySha256: sourceHash, home: nativeHome, port, startedAt: new Date().toISOString() };
  let mcp, serveInfo, mcpInfo, token = '';
  try {
    mcp = new McpSession(wslExe, env);
    record.mcp = await mcp.initialize();
    const cfg = JSON.parse(await readFile(join(wslHome, 'config.json'), 'utf8'));
    token = cfg.token;
    assert.match(token, /^[0-9a-f]{64}$/);
    const servePid = Number((await readFile(join(wslHome, 'serve.pid'), 'utf8')).trim());
    serveInfo = await processInfo(servePid);
    verifyOwner(serveInfo, nativeExe, 'serve', port);
    mcpInfo = (await ownedProcesses(nativeExe)).find(info => /(?:^|\s)mcp(?:\s|$)/.test(info.commandLine));
    verifyOwner(mcpInfo, nativeExe, 'mcp', port);
    record.serve = serveInfo;
    record.nativeMcp = mcpInfo;
    record.nativeHomeEnvironmentVerified = true;
    record.autoStartedMissingServe = await windowsPortOpen(port);
    assert.equal(record.autoStartedMissingServe, true);
    record.detachedLaunchMethod = cleanText(mcp.stderr).match(/launch_method=(?:"?)(windows-breakaway|windows-detached-fallback)/)?.[1];
    record.configAcl = await aclInfo(win32.join(nativeHome, 'config.json'));
    try { record.mcpExit = await mcp.close(); }
    catch (error) {
      record.nativeMcpAfterEofTimeout = await processInfo(mcpInfo.pid);
      record.interopChildAfterEofTimeout = { exitCode: mcp.child.exitCode, signalCode: mcp.child.signalCode, stdinDestroyed: mcp.child.stdin.destroyed, stdinFinished: mcp.child.stdin.writableFinished };
      throw error;
    }
    assert.equal(record.mcpExit.code, 0);
    assert.equal(record.mcpExit.signal, null);
    const surviving = await processInfo(servePid);
    verifyOwner(surviving, nativeExe, 'serve', port);
    assert.equal(surviving.created, serveInfo.created);
    record.serveSurvivedMcpExit = await windowsPortOpen(port);
    assert.equal(record.serveSurvivedMcpExit, true);
    assert.equal(await processInfo(mcpInfo.pid), null);
    let second;
    try { await execFile(wslExe, ['serve', '--port', String(port)], { env, timeout: 10_000 }); throw new Error('Second serve unexpectedly succeeded'); }
    catch (error) {
      if (error.code === undefined || !error.stderr) throw error;
      second = { exitCode: error.code, stdout: cleanText(error.stdout), stderr: cleanText(error.stderr) };
    }
    assert.match(second.stderr, /already running/);
    record.secondServeRejected = { exitCode: second.exitCode, alreadyRunning: true };
    record.stdoutJsonRpcOnly = mcp.invalidLines.length === 0 && mcp.messages.every(message => message.jsonrpc === '2.0');
    assert.equal(record.stdoutJsonRpcOnly, true);
    record.stdoutMessageCount = mcp.messages.length;
    const stderr = cleanText(mcp.stderr);
    const method = stderr.match(/launch_method=(?:"?)(windows-breakaway|windows-detached-fallback)/)?.[1];
    assert(method, 'Native detached launch method must be observable in MCP stderr');
    record.detachedLaunchMethod = method;
    const serveLog = await readFile(join(wslHome, 'logs', 'serve.log'), 'utf8');
    record.tokenAbsentFromLogs = ![stderr, second.stderr, second.stdout, serveLog, JSON.stringify(mcp.messages)].some(text => text.includes(token));
    assert.equal(record.tokenAbsentFromLogs, true);
    record.configAcl = await aclInfo(win32.join(nativeHome, 'config.json'));
    await writeFile(join(resultDir, `${label}-mcp.stderr.log`), stderr, { mode: 0o600 });
    await writeFile(join(resultDir, `${label}-serve.log`), serveLog, { mode: 0o600 });
    await writeFile(join(resultDir, `${label}-stdout.jsonl`), mcp.messages.map(message => JSON.stringify(message)).join('\n') + '\n', { mode: 0o600 });
    record.passed = true;
    return record;
  } catch (error) {
    record.passed = false;
    if (mcp) {
      const stderr = cleanText(mcp.stderr).replaceAll(token || '\u0000', '[REDACTED]');
      await writeFile(join(resultDir, `${label}-mcp.stderr.log`), stderr, { mode: 0o600 });
    }
    record.error = cleanText(error.message).replaceAll(token || '\u0000', '[REDACTED]');
    return record;
  } finally {
    // Unique copied executable paths are owned by this run. Never kill a shared filename or PID alone.
    if (mcp && mcp.child.exitCode === null && mcp.child.signalCode === null) {
      try { await mcp.close(); } catch {}
    }
    Object.assign(record, await cleanupOwnedProcesses({ executable: nativeExe, port, home: wslHome }));
    if (!record.ownedProcessesCleaned || record.cleanupErrors?.length) record.passed = false;
    record.finishedAt = new Date().toISOString();
  }
}

async function main() {
  assert.equal(process.platform, 'linux', 'Run this verification from WSL so Windows exe launch uses interop');
  const nativeNode = await nativeJson("console.log(JSON.stringify({platform:process.platform,version:process.version,arch:process.arch,localAppData:process.env.LOCALAPPDATA}));");
  assert.equal(nativeNode.platform, 'win32');
  const defaultExe = await toWsl(win32.join(nativeNode.localAppData, 'AgentBrowser-dev', 'testing', 'target', 'x86_64-pc-windows-msvc', 'release', 'browser-bridge.exe'));
  const sourceExe = resolve(argument('--exe', defaultExe));
  assert(sourceExe.startsWith('/mnt/') && sourceExe.endsWith('.exe'));
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const resultDir = resolve(argument('--out', join(ROOT, 'tests/agent/results', `interop-${stamp}`)));
  await mkdir(resultDir, { recursive: true });
  const nativeRoot = await nativeJson("const fs=require('node:fs'),os=require('node:os'),path=require('node:path');console.log(JSON.stringify(fs.mkdtempSync(path.join(process.env.LOCALAPPDATA,'AgentBrowser-interop-'))));");
  const wslRoot = await toWsl(nativeRoot);
  const evidence = { startedAt: new Date().toISOString(), runnerPlatform: process.platform, runnerNode: process.version, nativeNode, sourceExe, nativeRoot, homeParent: "LocalApplicationData", results: [] };
  try {
    const selectedCase = argument('--case', 'both');
    const cases = selectedCase === 'standard-path' ? [false] : selectedCase === 'korean-space-path' ? [true] : [false, true];
    for (const unicode of cases) {
      const label = unicode ? 'korean-space-path' : 'standard-path';
      let result;
      try { result = await runCase({ label, sourceExe, nativeRoot, wslRoot, resultDir, unicode }); }
      catch (error) { result = { label, passed: false, error: String(error.message), ownedProcessesCleaned: false }; }
      evidence.results.push(result);
      console.log(`${result.label}: ${result.passed ? 'PASS' : 'FAIL'} (${result.detachedLaunchMethod ?? result.error})`);
    }
    evidence.passed = evidence.results.every(result => result.passed && result.ownedProcessesCleaned);
  } finally {
    await finalizeEvidence({ evidence, resultDir, wslRoot });
    console.log(`Evidence: ${resultDir}`);
  }
  if (!evidence.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
