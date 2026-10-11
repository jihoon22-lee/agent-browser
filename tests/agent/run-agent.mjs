import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig, isolatedEnvironment, assertResolvedConfig, parseModelCatalog, verifyFreeModel, scoreRun, stopReason, verifyOfficialPricing } from './runner-lib.mjs';
import { McpProbe } from './mcp-probe.mjs';

const exec = promisify(execFile);
const usage = `Usage: run-agent.sh opencode/<model> <runs> --exe <Windows exe interop path> --bridge-home <isolated Windows home> --bridge-port <port>
  --fixture-url http://127.0.0.1:8790  --tab-id <fixture tab>
  --opencode <installed executable>  --timeout-ms 300000
  --fixture-via-windows-node [--windows-node <interop path>]
  --price-source official|refresh (default: official pricing + live model list + installed metadata)
  --check-only   Verify isolated config and free-model evidence; do not start MCP or call an LLM.
Results and generated config are saved only under ignored tests/agent/results/.`;

function argumentsForRun() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    exe: { type: 'string' }, 'bridge-home': { type: 'string' }, 'bridge-port': { type: 'string' },
    'fixture-url': { type: 'string', default: 'http://127.0.0.1:8790' }, 'tab-id': { type: 'string' },
    opencode: { type: 'string', default: join(homedir(), '.opencode', 'bin', 'opencode') },
    'timeout-ms': { type: 'string', default: '300000' }, 'check-only': { type: 'boolean', default: false },
    'fixture-via-windows-node': { type: 'boolean', default: false }, 'windows-node': { type: 'string', default: '/mnt/c/Program Files/nodejs/node.exe' },
    'price-source': { type: 'string', default: 'official' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) { console.log(usage); process.exit(0); }
  if (positionals.length !== 2) throw new Error(usage);
  const [model, count] = positionals;
  const options = { model, runs: Number(count), exe: values.exe, bridgeHome: values['bridge-home'], bridgePort: Number(values['bridge-port']), opencode: values.opencode, timeoutMs: Number(values['timeout-ms']), checkOnly: values['check-only'], tabId: values['tab-id'] === undefined ? undefined : Number(values['tab-id']), windowsNode: values['windows-node'], fixtureViaWindows: values['fixture-via-windows-node'] };
  options.priceSource = values['price-source'];
  if (!['official', 'refresh'].includes(options.priceSource)) throw new Error('price-source must be official or refresh');
  buildConfig(options);
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) throw new Error('Runs must be an integer from 1 through 20');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 900000) throw new Error('timeout-ms must be 1000..900000');
  if (options.tabId !== undefined && (!Number.isInteger(options.tabId) || options.tabId < 0)) throw new Error('tab-id must be a nonnegative integer');
  const fixture = new URL(values['fixture-url']);
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || fixture.pathname !== '/' || fixture.search || fixture.hash || fixture.username || fixture.password) throw new Error('Fixture URL must be an http://127.0.0.1:<port> origin');
  options.fixtureUrl = fixture.origin;
  return options;
}

async function jsonFile(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }

async function cli(options, args, env, cwd) {
  return exec(options.opencode, args, { env, cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
}

async function fixtureRequest(options, endpoint, method = 'GET') {
  const url = options.fixtureUrl + endpoint;
  if (options.fixtureViaWindows) {
    const script = 'const r=await fetch(process.argv[1],{method:process.argv[2],signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error("Fixture HTTP "+r.status);console.log(JSON.stringify(await r.json()));';
    const { stdout } = await exec(options.windowsNode, ['--input-type=module', '-e', script, url, method], { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true });
    return JSON.parse(stdout);
  }
  const response = await fetch(url, { method, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Fixture HTTP ' + response.status);
  return response.json();
}

function fixtureTab(preflight, options) {
  const data = preflight.tabs?.data;
  const tabs = Array.isArray(data) ? data : data?.tabs;
  if (!Array.isArray(tabs)) throw new Error('Browser tab list has an unknown shape');
  const matches = tabs.filter(tab => tab.url?.startsWith(options.fixtureUrl + '/search.html') && (options.tabId === undefined || tab.tabId === options.tabId));
  if (matches.length !== 1) throw new Error('Open one isolated fixture search tab or select it explicitly with --tab-id');
  return matches[0].tabId;
}

function executeAgent(options, args, env, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(options.opencode, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', buffer = '', stopped = null, killTimer;
    const events = [];
    const terminate = (reason) => {
      if (stopped) return;
      stopped = reason;
      const kill = (signal) => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 3000);
    };
    const timeout = setTimeout(() => terminate('Run deadline exceeded'), options.timeoutMs);
    child.on('error', error => { clearTimeout(timeout); clearTimeout(killTimer); reject(error); });
    child.stdout.on('data', chunk => {
      stdout += String(chunk); buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { const event = JSON.parse(line); events.push(event); const reason = stopReason([event]); if (reason) terminate(reason); }
        catch { terminate('OpenCode JSON output contained an invalid event'); }
      }
      if (stdout.length > 16 * 1024 * 1024) terminate('Run output exceeded 16 MiB');
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); const reason = stopReason([], stderr); if (reason) terminate(reason); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout); clearTimeout(killTimer);
      if (buffer.trim()) { try { events.push(JSON.parse(buffer)); } catch { stopped ??= 'OpenCode JSON output ended with an incomplete event'; } }
      resolveRun({ stdout, stderr, events, exitCode, signal, stopReason: stopped ?? stopReason(events, stderr) });
    });
  });
}

async function main() {
  const options = argumentsForRun();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
  const resultDir = fileURLToPath(new URL('./results/' + stamp + '/', import.meta.url));
  console.log('Evidence directory: ' + resultDir);
  const runtime = join(resultDir, 'runtime');
  const workspace = join(runtime, 'workspace');
  const configPath = join(runtime, 'opencode.json');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const config = buildConfig(options);
  await jsonFile(configPath, config);
  const env = isolatedEnvironment(process.env, runtime, configPath);
  for (const key of ['OPENCODE_CONFIG_DIR', 'OPENCODE_TEST_HOME', 'OPENCODE_TEST_MANAGED_CONFIG_DIR']) await mkdir(env[key], { recursive: true, mode: 0o700 });
  const version = (await cli(options, ['--version'], env, workspace)).stdout.trim();
  if (version !== '1.18.29') throw new Error('This runner was verified against installed OpenCode 1.18.29; found ' + version);
  const resolved = JSON.parse((await cli(options, ['debug', 'config', '--pure'], env, workspace)).stdout);
  assertResolvedConfig(resolved, options);
  const verifyModel = async () => {
    const args = ['models', 'opencode', '--verbose', '--pure'];
    if (options.priceSource === 'refresh') args.push('--refresh');
    const { stdout, stderr } = await cli(options, args, env, workspace);
    if (/error|failed|unable/i.test(stderr)) throw new Error('Model metadata lookup reported a failure');
    const metadata = verifyFreeModel(options.model, parseModelCatalog(stdout));
    let source;
    if (options.priceSource === 'official') {
      const pricingUrl = 'https://opencode.ai/docs/zen/';
      const modelsUrl = 'https://opencode.ai/zen/v1/models';
      const [pricingResponse, modelsResponse] = await Promise.all([pricingUrl, modelsUrl].map(url => fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' })));
      if (!pricingResponse.ok || !modelsResponse.ok) throw new Error('Live official Zen pricing or availability could not be verified');
      source = { kind: 'official-live-plus-installed-metadata', pricingUrl, modelsUrl, ...verifyOfficialPricing(options.model, await pricingResponse.text(), await modelsResponse.json()) };
    } else source = { kind: 'successful-installed-catalogue-refresh', command: 'opencode models opencode --verbose --refresh --pure' };
    const publicMetadata = { checkedAt: new Date().toISOString(), model: options.model, providerID: metadata.providerID, id: metadata.id, cost: metadata.cost, capabilities: metadata.capabilities, status: metadata.status, source };
    await jsonFile(join(resultDir, 'model-metadata.json'), publicMetadata);
    return publicMetadata;
  };
  await verifyModel();
  console.log('Isolated config and zero-cost tool-capable model evidence verified: ' + options.model);
  if (options.checkOnly) { console.log('Check only; no MCP or LLM process was started. ' + resultDir); return; }
  await access(options.exe);
  const mcpEnv = { ...env, ...config.mcp.browser.environment };
  const template = await readFile(new URL('./prompt.md', import.meta.url), 'utf8');
  const summary = { startedAt: new Date().toISOString(), model: options.model, opencodeVersion: version, requestedRuns: options.runs, runs: [] };
  for (let index = 1; index <= options.runs; index++) {
    if (index > 1) await verifyModel();
    const probe = new McpProbe(options.exe, mcpEnv);
    let run;
    try {
      const preflight = await probe.initialize();
      if (!preflight.browserConnected) throw new Error('MCP initialized, but Windows Chrome is not connected');
      const tabId = fixtureTab(preflight, options);
      await fixtureRequest(options, '/__reset', 'POST');
      const query = '합성 검색어 ' + index;
      const category = '도서';
      const prompt = template.replaceAll('{{FIXTURE_URL}}', options.fixtureUrl).replaceAll('{{TAB_ID}}', String(tabId)).replaceAll('{{QUERY}}', query).replaceAll('{{CATEGORY}}', category);
      const args = ['run', '--pure', '--format', 'json', '--title', 'AgentBrowser synthetic run ' + index, '--model', options.model, '--agent', 'browser-test', prompt];
      run = await executeAgent(options, args, env, workspace);
      await writeFile(join(resultDir, 'run-' + index + '.jsonl'), run.stdout, { mode: 0o600 });
      await writeFile(join(resultDir, 'run-' + index + '.stderr.log'), run.stderr, { mode: 0o600 });
      const fixtureLog = await fixtureRequest(options, '/__log');
      const scores = scoreRun({ events: run.events, fixtureLog, preflight, exitCode: run.exitCode, query, category, fixtureUrl: options.fixtureUrl });
      const sessionIds = [...new Set(run.events.map(event => event.sessionID ?? event.part?.sessionID).filter(Boolean))];
      const record = { index, exitCode: run.exitCode, signal: run.signal, stopReason: run.stopReason, sessionIds, scores };
      // Cleanup is runner work and never changes the model's scores.
      const activeOperations = new Set();
      for (const event of run.events.filter(event => event.type === 'tool_use')) {
        try {
          const outcome = JSON.parse(event.part?.state?.output);
          if (outcome.ok && outcome.tool === 'browser_tabs' && event.part.state.input?.action === 'attach' && outcome.operationId) activeOperations.add(outcome.operationId);
          if (outcome.ok && outcome.data?.released) activeOperations.delete(outcome.operationId);
        } catch {}
      }
      record.cleanup = [];
      for (const operationId of activeOperations) {
        try {
          const outcome = await probe.call('browser_tabs', { action: 'release', operationId });
          record.cleanup.push(outcome);
          if (!outcome.ok && outcome.error?.code !== 'OPERATION_INVALID') record.stopReason ??= 'Operation cleanup failed; stop before starting another run';
        } catch (error) {
          record.cleanup.push({ error: error.message });
          record.stopReason ??= 'Operation cleanup could not be confirmed';
        }
      }
      await jsonFile(join(resultDir, 'run-' + index + '-fixture.json'), fixtureLog);
      await jsonFile(join(resultDir, 'run-' + index + '.json'), record);
      summary.runs.push(record);
      await jsonFile(join(resultDir, 'summary.json'), summary);
      console.log(JSON.stringify({ run: index, communication: scores.communication.success, tools: scores.tools, model: scores.model.success }));
      if (record.stopReason || run.exitCode !== 0 || run.events.some(event => event.type === 'error')) break;
    } catch (error) {
      const failed = { index, exitCode: run?.exitCode ?? null, stopReason: error.message,
        scores: { communication: { success: false }, tools: { success: false, passed: 0, total: 0 }, model: { success: false } } };
      await jsonFile(join(resultDir, 'run-' + index + '.json'), failed);
      summary.runs.push(failed);
      await jsonFile(join(resultDir, 'summary.json'), summary);
      console.error('Run ' + index + ' stopped: ' + error.message);
      break;
    } finally {
      await probe.close();
      if (probe.stderr) await writeFile(join(resultDir, 'run-' + index + '-mcp.stderr.log'), probe.stderr, { mode: 0o600 });
    }
  }
  console.table(['communication', 'tools', 'model'].map(kind => ({ outcome: kind, passed: summary.runs.filter(run => run.scores[kind].success).length, total: summary.runs.length })));
  console.log('Evidence: ' + resultDir);
  if (summary.runs.length !== options.runs || summary.runs.some(run => !run.scores.model.success)) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
