#!/usr/bin/env node
// CI-only local documentation checks. No remote URLs or user files are fetched.
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function localLinks(markdown) {
  let fence;
  const prose = markdown.split(/\r?\n/).filter(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return false;
    }
    return !fence;
  }).join('\n').replace(/`+[^`\n]*`+/g, '');
  const targets = [
    ...prose.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g),
    ...prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)/gm),
  ].map(match => match[1].replace(/^<|>$/g, ''));
  return targets.filter(target => target && !target.startsWith('#') && !target.startsWith('//') && !/^[a-z][a-z\d+.-]*:/i.test(target));
}

export async function checkMarkdownLinks(root, files) {
  const failures = [];
  for (const file of files) {
    const markdown = await readFile(resolve(root, file), 'utf8');
    for (const target of localLinks(markdown)) {
      try {
        const path = decodeURIComponent(target.split(/[?#]/, 1)[0]);
        const absolute = path.startsWith('/') ? resolve(root, '.' + path) : resolve(root, file, '..', path);
        const within = relative(root, absolute);
        if (within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) throw new Error('outside the repository');
        await access(absolute);
      } catch (error) {
        failures.push(`${file}: ${target}: ${error.code === 'ENOENT' ? 'target does not exist' : error.message}`);
      }
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const failures = await checkMarkdownLinks(root, files);
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log(`PASS local Markdown file links (${files.length} tracked files; remote URLs and anchors are not checked)`);
}
