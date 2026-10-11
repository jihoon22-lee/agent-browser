// Synthetic local HTTP fixture; never calls a model or an OpenCode executable.
if (process.argv.includes('--version')) { console.log('1.18.29'); process.exit(0); }
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const authorization = 'Basic ' + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== authorization) { response.writeHead(401); response.end(); return; }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(request.url.startsWith('/doc')
    ? { paths: { '/session': {}, '/provider': {}, '/event': {}, '/mcp': {} } }
    : request.url.startsWith('/config') ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}') : { healthy: true, version: '1.18.29' }));
});
server.on('error', () => process.exit(1));
setTimeout(() => server.listen(port, '127.0.0.1'), 500);
