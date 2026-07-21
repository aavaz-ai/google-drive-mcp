#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testRoot = join(root, '.tmp-test', 'test');
const supersededDistributionSuites = new Set([
  join(testRoot, 'integration', 'cli-args.test.js'),
  join(testRoot, 'docs-reference.test.js'),
  join(testRoot, 'schema', 'registry-metadata.test.js'),
]);

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
  });
}

// These untouched suites assert upstream's browser/HTTP CLI and its npm/Registry
// identity and README. They intentionally conflict with the managed stdio-only
// executable and @enterpret package; focused managed tests cover those seams.
const files = testFiles(testRoot).filter((path) => !supersededDistributionSuites.has(path));
// One untouched refresh-event test uses a short wall-clock wait and flakes when
// Node runs the full suite under parallel CPU load. Serial file execution keeps
// the upstream assertions intact while making the fork's release gate stable.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  env: { ...process.env, MCP_TESTING: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
