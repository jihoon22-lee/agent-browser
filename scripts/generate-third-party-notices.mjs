#!/usr/bin/env node
// Build-time inventory only. The shipped application never downloads packages.
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, 'release', 'notices');
const target = 'x86_64-pc-windows-msvc';
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--locked', '--format-version', '1', '--filter-platform', target], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const bridge = metadata.packages.find(pkg => pkg.name === 'agent-browser-bridge');
if (!bridge) throw new Error('Bridge package metadata was not found');
const included = new Set();
function walkRust(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dep of nodes.get(id)?.deps ?? []) {
    if (dep.dep_kinds.some(kind => kind.kind !== 'dev')) walkRust(dep.pkg);
  }
}
walkRust(bridge.id);
included.delete(bridge.id);

async function licenseFiles(directory, declared) {
  const names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(entry.name)).map(entry => entry.name);
  if (declared && !names.includes(declared)) names.push(declared);
  const result = [];
  for (const name of [...new Set(names)].sort()) {
    const text = await readFile(resolve(directory, name), 'utf8');
    if (!text.trim()) continue;
    result.push({ name, text, sha256: createHash('sha256').update(text).digest('hex') });
  }
  return result;
}
const fallbacks = JSON.parse(await readFile(join(root, 'scripts', 'licenses', 'manifest.json'), 'utf8'));
const inventory = [];
for (const id of [...included].sort()) {
  const pkg = packages.get(id);
  if (!pkg) throw new Error('Dependency metadata missing: ' + id);
  const files = await licenseFiles(dirname(pkg.manifest_path), pkg.license_file);
  if (!files.length) {
    const fallback = fallbacks[pkg.name + '@' + pkg.version];
    if (!fallback) throw new Error(`No license text found for ${pkg.name}@${pkg.version}`);
    const text = await readFile(join(root, 'scripts', 'licenses', fallback.file), 'utf8');
    const sha256 = createHash('sha256').update(text).digest('hex');
    if (sha256 !== fallback.sha256) throw new Error('Vendored license checksum mismatch: ' + fallback.file);
    files.push({ name: 'LICENSE (upstream exact release commit)', text, sha256, source: fallback.source });
  }
  inventory.push({ ecosystem: 'cargo', name: pkg.name, version: pkg.version, license: pkg.license ?? 'SEE LICENSE FILE', source: `https://crates.io/crates/${pkg.name}/${pkg.version}`, files });
}

const npmSeen = new Set();
async function walkNpm(name, from) {
  const require = createRequire(from);
  let manifest;
  try { manifest = require.resolve(name + '/package.json'); }
  catch {
    let folder = dirname(require.resolve(name));
    for (;;) {
      try { const candidate = join(folder, 'package.json'); const pkg = JSON.parse(await readFile(candidate, 'utf8')); if (pkg.name === name) { manifest = candidate; break; } } catch {}
      const parent = dirname(folder); if (parent === folder) throw new Error('Cannot locate npm manifest: ' + name); folder = parent;
    }
  }
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  const identity = pkg.name + '@' + pkg.version;
  if (npmSeen.has(identity)) return;
  npmSeen.add(identity);
  const files = await licenseFiles(dirname(manifest));
  if (!files.length) throw new Error('No license text found for ' + identity);
  inventory.push({ ecosystem: 'npm', name: pkg.name, version: pkg.version, license: pkg.license ?? 'SEE LICENSE FILE', source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, files });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) await walkNpm(dependency, manifest);
}
const extensionManifest = join(root, 'extension', 'package.json');
const extension = JSON.parse(await readFile(extensionManifest, 'utf8'));
for (const name of Object.keys(extension.dependencies ?? {})) await walkNpm(name, extensionManifest);
inventory.sort((a,b) => (a.ecosystem + '/' + a.name + '/' + a.version).localeCompare(b.ecosystem + '/' + b.name + '/' + b.version));
const heading = ['AgentBrowser third-party notices', '', 'Inventory: Windows x64 Bridge normal/build dependency closure and bundled Extension production dependencies.', 'Generated from the locked build dependency metadata. Package source directories and user configuration are not included.', 'The texts below are the upstream license/notice files as distributed with each dependency.', ''];
for (const item of inventory) {
  heading.push('='.repeat(78), `${item.ecosystem}: ${item.name} ${item.version}`, `License: ${item.license}`, `Source: ${item.source}`, '');
  for (const file of item.files) heading.push(`--- ${file.name} ---`, file.text.trimEnd(), '');
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'THIRD_PARTY_NOTICES'), heading.join('\n') + '\n');
const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(join(output, 'third-party-inventory.json'), JSON.stringify({ target, cargoLockSha256: await hashFile(join(root, 'Cargo.lock')), pnpmLockSha256: await hashFile(join(root, 'pnpm-lock.yaml')), extensionPackageSha256: await hashFile(extensionManifest), packages: inventory.map(({ files, ...item }) => ({ ...item, files: files.map(({ name, sha256, source }) => ({ name, sha256, ...(source ? { source } : {}) })) })) }, null, 2) + '\n');
console.log(`Third-party notices generated: ${inventory.length} packages -> ${output}`);
