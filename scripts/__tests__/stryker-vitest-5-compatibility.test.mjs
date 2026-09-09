import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireUtils = createRequire(path.join(root, 'packages/utils/package.json'));
const run = promisify(execFile);

// BST-1690: exercise the installed pnpm package, including sandbox coverage IDs.
// A dry run alone stays green with the incompatible unpatched runner.
test('Stryker kills Vitest 5 nested-test mutants and reports the killing test', async () => {
  const cache = path.join(root, '.stryker-tmp');
  await mkdir(cache, { recursive: true });
  const fixture = await mkdtemp(path.join(cache, 'stryker-vitest-5-'));
  try {
    await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(fixture, 'add.js'), 'export function add(a, b) { return a + b; }');
    await writeFile(
      path.join(fixture, 'add.test.js'),
      `
      import { describe, it, expect } from 'vitest';
      import { add } from './add.js';
      describe('math (numbers)', () => {
        describe('add', () => {
          it('adds two numbers', () => { expect(add(2, 3)).toBe(5); });
        });
      });
    `
    );
    await writeFile(
      path.join(fixture, 'vitest.config.mjs'),
      "export default { test: { include: ['add.test.js'] } };"
    );
    await writeFile(
      path.join(fixture, 'stryker.conf.json'),
      JSON.stringify({
        concurrency: 1,
        coverageAnalysis: 'perTest',
        mutate: ['add.js'],
        plugins: [requireUtils.resolve('@stryker-mutator/vitest-runner')],
        reporters: ['json'],
        testRunner: 'vitest',
        thresholds: { break: 100 },
        vitest: { configFile: 'vitest.config.mjs' },
      })
    );
    const cli = path.join(
      path.dirname(requireUtils.resolve('@stryker-mutator/core/package.json')),
      'bin/stryker.js'
    );
    await run(process.execPath, [cli, 'run'], { cwd: fixture, timeout: 60_000 });
    const report = JSON.parse(
      await readFile(path.join(fixture, 'reports/mutation/mutation.json'), 'utf8')
    );
    const tests = report.testFiles['add.test.js'].tests;
    assert.deepEqual(tests, [{ id: '0', name: 'math (numbers) > add > adds two numbers' }]);
    const mutants = report.files['add.js'].mutants;
    assert.ok(mutants.length > 0);
    for (const mutant of mutants) {
      assert.equal(mutant.status, 'Killed');
      assert.deepEqual(mutant.killedBy, ['0']);
    }
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
