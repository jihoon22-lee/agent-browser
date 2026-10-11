/** Synthetic v1 HTTP/SSE fixture for UI verification. No model or OpenCode process is called. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function startOpenCodeFixture() {
  const password = randomBytes(16).toString('hex'), username = 'opencode';
  const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const streams = new Set(), timers = new Set();
  let sequence = 0;
  const next = prefix => prefix + '_' + String(++sequence).padStart(6, '0');
  const state = { sessions: [], messages: new Map(), questions: [], permissions: [], statuses: {}, requests: [], replies: [], modelsCalled: 0 };
  const directory = '/synthetic/workspace';
  const tokens = { input: 20, output: 8, reasoning: 2, cache: { read: 10, write: 0 } };
  const model = { id: 'fixture', providerID: 'fixture', name: '합성 모델', api: { id: 'fixture', url: 'http://127.0.0.1', npm: '@ai-sdk/openai-compatible' }, family: 'fixture', capabilities: { temperature: true, reasoning: true, attachment: true, toolcall: true, input: { text: true, image: true, audio: false, video: false, pdf: true }, output: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 8192, input: 7000, output: 1024 }, status: 'active', options: {}, headers: {}, release_date: '2026-01-01', variants: { brief: {}, deep: {} } };
  const provider = { id: 'fixture', name: '합성 제공자', source: 'config', env: [], options: {}, models: { fixture: model, alternate: { ...model, id: 'alternate', name: '대체 합성 모델' } } };
  const commands = ['command', 'mcp', 'skill'].map(source => ({ name: source + '-fixture', source, description: '합성 ' + source, template: 'synthetic $ARGUMENTS', hints: ['$ARGUMENTS'] }));
  const spec = JSON.parse(await readFile(new URL('../../docs/reference/opencode-1.18.29-openapi.json', import.meta.url), 'utf8'));
  const emit = (type, properties) => { const event = { id: next('evt'), type, properties }; for (const stream of streams) stream.write('data: ' + JSON.stringify(event) + '\n\n'); return event; };
  const status = (id, type) => { state.statuses[id] = { type }; emit('session.status', { sessionID: id, status: { type } }); };
  const schedule = fn => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, 30); timers.add(timer); };
  function session(body = {}, dir = directory) {
    const value = { id: next('ses'), slug: 'synthetic', projectID: 'synthetic', directory: dir, title: body.title || '새 합성 세션', version: '1.18.29', time: { created: Date.now(), updated: Date.now() }, ...(body.model ? { model: body.model } : {}), ...(body.agent ? { agent: body.agent } : {}), ...(body.parentID ? { parentID: body.parentID } : {}) };
    state.sessions.push(value); state.messages.set(value.id, []); emit('session.created', { info: value }); return value;
  }
  function saveMessage(record) {
    const records = state.messages.get(record.info.sessionID); if (!records) throw new Error('Unknown fixture session');
    const i = records.findIndex(item => item.info.id === record.info.id); if (i < 0) records.push(record); else records[i] = record;
    emit('message.updated', { sessionID: record.info.sessionID, info: record.info });
    for (const part of record.parts) emit('message.part.updated', { sessionID: record.info.sessionID, part, time: Date.now() });
  }
  function answer(id, parentID, text = '합성 응답입니다. **안전한 Markdown**\n\n```text\n한글 코드 블록\n```\n<img src=x onerror=alert(1)>') {
    const messageID = next('msg'), partID = next('prt');
    const info = { id: messageID, parentID, sessionID: id, role: 'assistant', time: { created: Date.now(), completed: Date.now() }, agent: 'build', mode: 'build', modelID: 'fixture', providerID: 'fixture', path: { cwd: directory, root: directory }, cost: 0, tokens };
    const part = { id: partID, sessionID: id, messageID, type: 'text', text: '' };
    const record = { info, parts: [part] }; saveMessage(record);
    emit('message.part.delta', { sessionID: id, messageID, partID, field: 'text', delta: text.slice(0, 7) });
    emit('message.part.delta', { sessionID: id, messageID, partID, field: 'text', delta: text.slice(7) });
    part.text = text;
    record.parts.push({ id: next('prt'), sessionID: id, messageID, type: 'step-finish', reason: 'stop', tokens, cost: 0 });
    saveMessage(record); status(id, 'idle'); return record;
  }
  const addQuestion = id => {
    const request = { id: next('que'), sessionID: id, questions: [
      { header: '색상', question: '색상을 선택하세요', options: [{ label: '파랑', description: '첫 선택' }, { label: '초록', description: '다른 선택' }], multiple: true, custom: true },
      { header: '이름', question: '직접 이름을 입력하세요', options: [], custom: true },
    ] };
    state.questions.push(request); emit('question.asked', request); return request;
  };
  const addPermission = id => {
    const request = { id: next('per'), sessionID: id, permission: 'bash', patterns: ['echo 합성'], always: ['echo *'], metadata: { command: 'echo 합성', description: '합성 권한 요청' } };
    state.permissions.push(request); emit('permission.asked', request); return request;
  };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin?.startsWith('chrome-extension://')) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS'); }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const send = (value, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (req.headers.authorization !== auth) { send({ message: 'Unauthorized' }, 401); return; }
    const url = new URL(req.url, 'http://127.0.0.1'), path = decodeURIComponent(url.pathname);
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 25 * 1024 * 1024) { send({ message: 'Too large' }, 413); return; } }
    let body = {}; try { if (raw) body = JSON.parse(raw); } catch { send({ message: 'Bad JSON' }, 400); return; }
    state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });
    try {
      if (path === '/global/health') return send({ healthy: true, version: '1.18.29' });
      if (path === '/doc') return send(spec);
      if (path === '/config') return send({ model: 'fixture/fixture', mcp: { browser: { type: 'local', command: ['browser-bridge.exe', 'mcp'], enabled: true } } });
      if (path === '/provider') return send({ all: [provider, { ...provider, id: 'unavailable', models: { hidden: { ...model, providerID: 'unavailable', id: 'hidden', name: '노출 금지 모델' } } }], connected: ['fixture'], default: { fixture: 'fixture' } });
      if (path === '/config/providers') return send({ providers: [provider], default: { fixture: 'fixture' } });
      if (path === '/agent') return send([{ name: 'build', mode: 'primary', native: true, permission: [], options: {} }, { name: 'custom-fixture', description: '사용자 에이전트', mode: 'all', permission: [], options: {} }]);
      if (path === '/command') return send(commands);
      if (path === '/skill') return send([{ name: 'attached-skill', description: '정의를 첨부하는 스킬', location: '/synthetic/skills/SKILL.md', content: '# 합성 스킬\n현재 문서의 요약을 작성한다.' }]);
      if (path === '/mcp') return send({ browser: { status: 'connected' } });
      if (path === '/event') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); streams.add(res); res.write('data: ' + JSON.stringify({ id: next('evt'), type: 'server.connected', properties: {} }) + '\n\n'); req.on('close', () => streams.delete(res)); return; }
      if (path === '/question' && req.method === 'GET') return send(state.questions);
      if (path === '/permission' && req.method === 'GET') return send(state.permissions);
      const pending = /^\/(question|permission)\/([^/]+)\/(reply|reject)$/.exec(path);
      if (pending) {
        const key = pending[1] === 'question' ? 'questions' : 'permissions', index = state[key].findIndex(value => value.id === pending[2]);
        if (index < 0) return send({ message: 'Request already handled' }, 404);
        const request = state[key].splice(index, 1)[0]; state.replies.push({ kind: pending[1], id: request.id, body });
        emit(pending[1] + (pending[3] === 'reject' ? '.rejected' : '.replied'), { requestID: request.id, sessionID: request.sessionID, ...body }); return send(true);
      }
      if (path === '/session/status') return send(state.statuses);
      if (path === '/session') {
        if (req.method === 'POST') return send(session(body, url.searchParams.get('directory') || directory));
        const search = url.searchParams.get('search') || '', roots = url.searchParams.get('roots') === 'true', limit = Number(url.searchParams.get('limit') || 100); return send(state.sessions.filter(value => value.title.includes(search) && (!roots || !value.parentID)).sort((a, b) => b.time.updated - a.time.updated).slice(0, limit));
      }
      if (path === '/find/file') return send(['합성 파일.txt', 'README.md'].filter(value => value.includes(url.searchParams.get('query') || '')));
      if (path === '/file/content') return send({ type: 'text', content: '서버 파일 합성 내용', mimeType: 'text/plain' });
      if (path === '/file') return send([{ name: '합성 파일.txt', path: '합성 파일.txt', absolute: '/synthetic/workspace/합성 파일.txt', type: 'file', ignored: false }]);
      const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (!match) return send({ message: 'Unknown fixture API: ' + path }, 404);
      const id = match[1], action = match[2], current = state.sessions.find(value => value.id === id);
      if (!current) return send({ message: 'Session not found' }, 404);
      if (!action) {
        if (req.method === 'DELETE') { state.sessions = state.sessions.filter(value => value.id !== id); state.messages.delete(id); emit('session.deleted', { info: current }); return send(true); }
        if (req.method === 'PATCH') { Object.assign(current, body); current.time.updated = Date.now(); emit('session.updated', { info: current }); }
        return send(current);
      }
      if (action === 'message') return send(state.messages.get(id));
      if (action === 'todo') return send([{ id: 'todo_1', content: '합성 작업 확인', status: 'completed', priority: 'medium' }]);
      if (action === 'children') return send(state.sessions.filter(value => value.parentID === id));
      if (action === 'diff') return send([{ file: 'fixture.txt', before: '이전 내용', after: '변경 내용', additions: 1, deletions: 1 }]);
      if (action === 'abort') { status(id, 'idle'); return send(true); }
      if (action === 'fork') { const branch = session({ title: current.title + ' (fork #1)' }, current.directory); const records = state.messages.get(id); const end = body.messageID ? records.findIndex(record => record.info.id === body.messageID) : records.length; state.messages.set(branch.id, records.slice(0, end < 0 ? records.length : end).map(record => ({ info: { ...record.info, id: next('msg'), sessionID: branch.id }, parts: [] }))); return send(branch); }
      if (action === 'revert') { current.revert = { messageID: body.messageID }; emit('session.updated', { info: current }); return send(current); }
      if (action === 'unrevert') { delete current.revert; emit('session.updated', { info: current }); return send(current); }
      if (action === 'summarize') { const messageID = next('msg'); saveMessage({ info: { id: messageID, sessionID: id, role: 'user', time: { created: Date.now() }, agent: 'build', model: { providerID: 'fixture', modelID: 'fixture' } }, parts: [{ id: next('prt'), messageID, sessionID: id, type: 'compaction', auto: false }] }); const record = answer(id, messageID, '합성 압축 결과'); record.info.summary = true; saveMessage(record); emit('session.compacted', { sessionID: id }); return send(true); }
      if (action === 'shell') { const record = answer(id, next('msg'), '합성 셸 실행 결과'); record.parts.push({ id: next('prt'), sessionID: id, messageID: record.info.id, type: 'tool', tool: 'bash', callID: next('call'), state: { status: 'completed', input: { command: body.command }, output: '합성 셸 실행 결과', title: '합성 셸', metadata: {}, time: { start: Date.now(), end: Date.now() } } }); saveMessage(record); return send(record); }
      if (action === 'prompt_async' || action === 'command') {
        const messageID = body.messageID || next('msg');
        const parts = action === 'command' ? [{ type: 'text', text: '/' + body.command + ' ' + body.arguments }, ...(body.parts || [])] : body.parts;
        saveMessage({ info: { id: messageID, sessionID: id, role: 'user', time: { created: Date.now() }, agent: body.agent || 'build', model: typeof body.model === 'object' ? body.model : { providerID: 'fixture', modelID: 'fixture' } }, parts: parts.map(part => ({ ...part, id: next('prt'), messageID, sessionID: id })) });
        status(id, 'busy'); if (action === 'command') return send(answer(id, messageID, '합성 커맨드 실행 결과'));
        send(undefined, 204); schedule(() => answer(id, messageID)); return;
      }
      return send({ message: 'Unsupported fixture action' }, 404);
    } catch (error) { if (!res.headersSent) send({ message: error.message }, 500); else res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, username, password, directory, state, emit, addQuestion, addPermission, saveMessage, session, disconnectEvents() { for (const stream of streams) stream.end(); streams.clear(); }, async close() { for (const timer of timers) clearTimeout(timer); for (const stream of streams) stream.end(); streams.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
