import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { scripts } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// The stub `node` below only asserts on argv, so pin the wrapper's existence here:
// moving or renaming it must fail this suite, not just `pnpm knip`.
assert.ok(
  existsSync(path.join(repoRoot, 'scripts/run-turbo-command.mjs')),
  'scripts/run-turbo-command.mjs must exist for the knip script'
);

// Execute the real package command across the process boundary. Stand-in binaries
// model absent build outputs and failures without rebuilding the repo in this suite.
// The fixture lives in the OS temp dir: it holds executables named `node`/`knip`/`turbo`,
// which must never be left inside the repository if the process is interrupted.
function runWorkflow(buildExit, auditExit) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-knip-workflow-'));
  try {
    const binaries = {
      knip: `
        import assert from 'node:assert/strict';
        import { appendFileSync, existsSync } from 'node:fs';
        appendFileSync('events.log', 'audit\\n');
        assert.ok(existsSync('platform-utils-built'), 'platform-utils must be built before analysis');
        assert.ok(existsSync('build-utils-built'), 'build-utils must be built before analysis');
        process.exit(${auditExit});
      `,
      node: `
        import assert from 'node:assert/strict';
        import { appendFileSync, writeFileSync } from 'node:fs';
        assert.deepEqual(process.argv.slice(2), [
          'scripts/run-turbo-command.mjs', '--', 'run', 'build',
          '--filter=@brainstrike/platform-utils', '--filter=@brainstrike/build-utils'
        ]);
        appendFileSync('events.log', 'build\\n');
        if (${buildExit} !== 0) process.exit(${buildExit});
        writeFileSync('platform-utils-built', 'ready');
        writeFileSync('build-utils-built', 'ready');
      `,
      turbo: `throw new Error('knip must build through the bounded Turbo wrapper');`,
    };
    for (const [name, source] of Object.entries(binaries)) {
      writeFileSync(path.join(fixture, `${name}.mjs`), source);
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(fixture, `${name}.cmd`),
          `@"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`
        );
      } else {
        writeFileSync(
          path.join(fixture, name),
          `#!/bin/sh\nexec "${process.execPath}" "${fixture}/${name}.mjs" "$@"\n`,
          { mode: 0o755 }
        );
      }
    }
    writeFileSync(path.join(fixture, 'events.log'), '');
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
    assert.ok(pathKey, 'the command fixture requires PATH');
    env[pathKey] = `${fixture}${path.delimiter}${env[pathKey]}`;
    const result = spawnSync(scripts.knip, {
      cwd: fixture,
      encoding: 'utf8',
      env,
      shell: true,
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return {
      events: readFileSync(path.join(fixture, 'events.log'), 'utf8'),
      exitCode: result.status,
      output: result.stdout + result.stderr,
    };
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

test('knip prepares both config dependencies before auditing a fresh checkout', () => {
  const result = runWorkflow(0, 0);
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.events, 'build\naudit\n');
});

test('knip fails without starting analysis when the prerequisite build fails', () => {
  const result = runWorkflow(17, 0);
  assert.equal(result.exitCode, 17, result.output);
  assert.equal(result.events, 'build\n');
});

test('knip preserves the auditor failure after a successful build', () => {
  const result = runWorkflow(0, 23);
  assert.equal(result.exitCode, 23, result.output);
  assert.equal(result.events, 'build\naudit\n');
});
