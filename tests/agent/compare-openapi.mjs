#!/usr/bin/env node
// Compares two OpenCode OpenAPI documents on the v1 surface this product uses: operations outside /api/*
// and component schemas. Exits 1 when a v1 operation or schema was removed or changed.
// Usage: node tests/agent/compare-openapi.mjs docs/reference/opencode-1.18.29-openapi.json other.json
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const [base, next] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')));
const operations = doc => new Map(Object.entries(doc.paths).filter(([path]) => !path.startsWith('/api/'))
  .flatMap(([path, methods]) => Object.entries(methods).filter(([method]) => method !== 'parameters').map(([method, op]) => [`${method.toUpperCase()} ${path}`, op])));
const [a, b] = [operations(base), operations(next)];
const sa = base.components?.schemas ?? {}, sb = next.components?.schemas ?? {};
const report = {
  removedOperations: [...a.keys()].filter(key => !b.has(key)),
  addedOperations: [...b.keys()].filter(key => !a.has(key)),
  changedOperations: [...a.keys()].filter(key => b.has(key) && !isDeepStrictEqual(a.get(key), b.get(key))),
  removedSchemas: Object.keys(sa).filter(key => !(key in sb)),
  addedSchemas: Object.keys(sb).filter(key => !(key in sa)),
  changedSchemas: Object.keys(sa).filter(key => key in sb && !isDeepStrictEqual(sa[key], sb[key])),
};
console.log(JSON.stringify(report, null, 2));
// Config schemas describe opencode.json, which this product only writes for isolated tests.
const breaking = report.removedOperations.length + report.changedOperations.length + report.removedSchemas.length
  + report.changedSchemas.filter(name => !['Config', 'ProviderConfig'].includes(name)).length;
process.exit(breaking ? 1 : 0);
