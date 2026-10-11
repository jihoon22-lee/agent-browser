import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkMarkdownLinks } from './ci-checks.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-browser-doc-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  return root;
}

test('documentation links resolve from their own file, including encoded Unicode and references', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', '한글 안내.md'), '# Heading');
  await writeFile(join(root, 'README.md'), '[guide](docs/%ED%95%9C%EA%B8%80%20%EC%95%88%EB%82%B4.md#heading)\n[second]: <docs/한글 안내.md>\n');
  assert.deepEqual(await checkMarkdownLinks(root, ['README.md']), []);
});

test('broken local links and repository escapes identify the source and target', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs', 'guide.md'), '[broken](missing.md)\n[escape](../../outside.md)\n');
  const failures = await checkMarkdownLinks(root, ['docs/guide.md']);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /docs\/guide\.md.*missing\.md/);
  assert.match(failures[1], /outside.*repository/);
});

test('examples, remote URLs, and same-page anchors do not become local-file requirements', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'README.md'), [
    '[web](https://example.test/path)', '[anchor](#heading)', '[chrome](chrome://extensions)',
    '`[inline example](missing.md)`', '```md', '[fenced example](missing.md)', '```',
    '~~~markdown', '[other fenced example](also-missing.md)', '~~~',
  ].join('\n'));
  assert.deepEqual(await checkMarkdownLinks(root, ['README.md']), []);
});
