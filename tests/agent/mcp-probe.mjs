import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { TOOL_NAMES } from './runner-lib.mjs';

/** A runner-owned MCP process. Never terminates serve or unrelated Windows processes. */
export class McpProbe {
  constructor(exe, env) {
    this.child = spawn(exe, ['mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.closed = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stderr.on('data', chunk => { this.stderr += String(chunk); });
    this.child.on('error', error => this.fail(error));
    this.child.on('close', () => this.fail(new Error('MCP process closed')));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('MCP stdout contains non-JSON output')); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error('MCP request failed: ' + JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
  }
  fail(error) {
    this.failure = error;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  request(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP timeout: ' + method)); }, 65000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => { if (error) this.fail(error); });
    });
  }
  async initialize() {
    const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-browser-validation', version: '0.1.0' } });
    if (result?.serverInfo?.name !== 'agent-browser') throw new Error('Unexpected MCP server identity');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const catalog = await this.request('tools/list');
    const names = catalog.tools?.map(tool => tool.name) ?? [];
    if (names.length !== TOOL_NAMES.length || TOOL_NAMES.some(name => !names.includes(name))) throw new Error('MCP tool catalogue differs from the browser contract');
    const tabs = await this.call('browser_tabs', { action: 'list' });
    return { initialized: true, toolsListed: true, browserConnected: tabs.ok === true && tabs.delivered === true, tabs };
  }
  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const content = result?.content?.find(item => item.type === 'text');
    if (!content) throw new Error('MCP response has no structured outcome text');
    const outcome = JSON.parse(content.text);
    if (typeof outcome.ok !== 'boolean' || outcome.tool !== name) throw new Error('MCP outcome does not match the requested tool');
    return outcome;
  }
  async close() {
    this.child.stdin.end();
    let timer;
    const exited = await Promise.race([this.closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(timer);
    if (!exited) this.child.kill('SIGTERM'); // This exact runner-owned mcp process only.
  }
}
