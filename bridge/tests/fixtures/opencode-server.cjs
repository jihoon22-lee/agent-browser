// Synthetic local HTTP fixture; never calls a model or an OpenCode executable.
if (process.argv.includes('--version')) { console.log('1.18.29'); process.exit(0); }
const fs = require('node:fs');
const http = require('node:http');
const started = Date.now();
const logfile = process.env.AGENT_BROWSER_FIXTURE_LOG;
function record(event, details = {}) {
  if (!logfile) return;
  try { fs.appendFileSync(logfile, JSON.stringify({ event, pid: process.pid, elapsedMs: Date.now() - started, ...details }) + '\n'); }
  catch { /* Diagnostics must not change fixture server behavior. */ }
}
function redact(text) {
  for (const secret of [process.env.OPENCODE_SERVER_PASSWORD, process.env.OPENCODE_CONFIG_CONTENT]) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text.replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic [redacted]').slice(0, 2048);
}
const writeStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => { record('stderr', { text: redact(String(chunk)) }); return writeStderr(chunk, ...args); };
function fail(error, event) {
  const code = typeof error.code === 'string' ? error.code : error.name || 'Error';
  record(event, { code }); console.error(`synthetic runtime ${event}: ${code}`); process.exit(1);
}
process.on('uncaughtException', error => fail(error, 'uncaught-exception'));
process.on('unhandledRejection', error => fail(error, 'unhandled-rejection'));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const authorization = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
record('started', { port, node: process.version });
const server = http.createServer((request, response) => {
  const path = request.url.startsWith('/doc') ? '/doc' : request.url.startsWith('/global/health') ? '/global/health' : request.url.startsWith('/config') ? '/config' : request.url.startsWith('/mcp') ? '/mcp' : 'other';
  const authenticated = request.headers.authorization === authorization;
  record('request', { path, authenticated });
  if (!authenticated) { response.writeHead(401); response.end(); return; }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(path === '/doc'
    ? { paths: { '/session': {}, '/provider': {}, '/event': {}, '/mcp': {} } }
    : path === '/mcp' ? { browser: { status: process.env.AGENT_BROWSER_FIXTURE_MCP_STATUS || (Date.now()-started < Number(process.env.AGENT_BROWSER_FIXTURE_MCP_DELAY_MS || 0) ? 'failed' : 'connected') } } : path === '/config' ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') : { healthy: true, version: '1.18.29' }));
});
server.on('error', error => fail(error, 'listen-error'));
setTimeout(() => server.listen(port, '127.0.0.1', () => record('listening', { port })), 500);
// A test failure must not leave a synthetic child behind if a broken ownership
// check prevents Manager::stop_all from recognizing it. Each test owns this file.
if (logfile) setInterval(() => { if (!fs.existsSync(__filename)) process.exit(0); }, 250).unref();
process.on('SIGTERM', () => { record('stopping'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); });
