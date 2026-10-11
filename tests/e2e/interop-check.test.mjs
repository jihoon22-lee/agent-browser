import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupOwnedProcesses, finalizeEvidence } from './interop-check.mjs';

const executable = 'C:\\owned-unique\\browser-bridge.exe';
const owned = [
  { pid: 10, executablePath: executable, commandLine: `"${executable}" serve --port 12345`, created: '2026-10-11T00:00:00Z' },
  { pid: 11, executablePath: executable, commandLine: `"${executable}" mcp`, created: '2026-10-11T00:00:01Z' },
];

test('missing or corrupt PID file does not skip independently verified owned process cleanup', async () => {
  for (const corrupt of [false, true]) {
    const remaining = new Map(owned.map(process => [process.pid, process]));
    const stopped = [];
    const result = await cleanupOwnedProcesses({
      executable, port: 12345, home: '/unused', query: async () => [...remaining.values()],
      readPid: async () => { if (corrupt) return 'not-a-pid'; throw new Error('ENOENT'); },
      stop: async (process, path, role, port) => { assert.equal(path, executable); assert.equal(port, 12345); stopped.push([process.pid, role]); remaining.delete(process.pid); },
      delay: async () => {},
    });
    assert.deepEqual(stopped, [[10, 'serve'], [11, 'mcp']]);
    assert.equal(result.ownedProcessesCleaned, true);
    assert.equal(result.cleanupWarnings.length, 1);
  }
});

test('identity mismatch is never terminated and does not skip other owned processes', async () => {
  const foreign = { ...owned[0], executablePath: 'C:\\not-owned\\browser-bridge.exe' };
  const remaining = new Map([[10, foreign], [11, owned[1]]]);
  const stopped = [];
  const result = await cleanupOwnedProcesses({
    executable, port: 12345, home: '/unused', query: async () => [...remaining.values()], readPid: async () => '10',
    stop: async (process) => { stopped.push(process.pid); remaining.delete(process.pid); }, delay: async () => {},
  });
  assert.deepEqual(stopped, [11]);
  assert.equal(result.ownedProcessesCleaned, false);
  assert.equal(result.cleanupErrors.length, 1);
});

test('temporary directory cleanup failure still leaves complete outcome evidence', async () => {
  const evidence = { passed: true, results: [{ label: 'case', passed: true, ownedProcessesCleaned: true }] };
  const writes = [];
  await finalizeEvidence({ evidence, resultDir: '/evidence', wslRoot: '/owned', remove: async () => { throw new Error('EPERM file locked'); }, save: async (path, data) => { writes.push([path, JSON.parse(data)]); } });
  assert.equal(writes.length, 2);
  assert.equal(writes[0][1].results[0].passed, true);
  assert.equal(writes[1][1].temporaryCleanupError, 'EPERM file locked');
  assert.equal(writes[1][1].passed, false);
});
