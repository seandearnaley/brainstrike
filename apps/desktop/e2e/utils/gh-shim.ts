/**
 * A fake `gh` on PATH for desktop E2E (spec §14).
 *
 * TEST-ONLY, and deliberately outside the product: the shim is a real
 * executable named `gh`, so `execFileGhRunner` resolves it exactly the way it
 * resolves the real binary — the pinned environment, the argument array, the
 * exit-code classification and the JSON parsing are all under test.
 *
 * One script (`SHIM`) is the fake on every platform. On POSIX `gh` is a
 * `#!/bin/sh` wrapper that runs it with this Node. On Windows the app's
 * shell-less `execFile('gh')` runs only `gh.exe` or `gh.com`, so `gh.exe` is a
 * Node single executable application built from it (`node --build-sea`, Node
 * 25.5 or later, which `.nvmrc` pins).
 *
 * Scope: prepending to `process.env.PATH` is process-global for the
 * Playwright WORKER, and workers are NOT one-per-file — a worker runs several
 * spec files in sequence (see `git-fixtures.ts`'s `TempDirTracker` comment for
 * the same fact applied to temp-dir tracking). What actually keeps this from
 * leaking is (1) each test gets its OWN Electron process via the test-scoped
 * `electron-fixture` — the shim is never shared across concurrently-running
 * app instances — and (2) `installGhShim`/`dispose()` are file-scoped
 * `beforeAll`/`afterAll` hooks, so one file's `dispose()` always restores the
 * previous PATH/env before the next file (reusing the same worker) installs
 * its own.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PR_FILE_ENV = 'BRAINSTRIKE_E2E_GH_PR_JSON';
const HOSTS_ENV = 'BRAINSTRIKE_E2E_GH_HOSTS';
const LOG_ENV = 'BRAINSTRIKE_E2E_GH_LOG';
/** Between one invocation's logged args and the next — never a real gh arg. */
const LOG_SEPARATOR = '--@@--';

export interface GhShim {
  readonly dispose: () => void;
  /**
   * Every `gh` invocation logged so far, each as its argv (excluding the
   * `gh` argv0 itself), in call order. Closes the wrong-repo blind spot: a
   * test can assert not just THAT gh was called but WITH WHICH `--repo` /
   * `--head` it was called, for a specific checked-out branch.
   */
  readonly readInvocations: () => string[][];
  /** Replace what `gh pr list --json …` prints. Takes effect on the next call. */
  readonly setPullRequests: (rows: readonly unknown[]) => void;
}

/** The fake: its arguments are argv[2..] under the sh wrapper and in the single executable. */
const SHIM = `'use strict';
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(
  process.env.${LOG_ENV},
  args.map((arg) => arg + '\\n').join('') + ${JSON.stringify(`${LOG_SEPARATOR}\n`)}
);
const fail = (message) => {
  process.stderr.write(message + '\\n');
  process.exit(1);
};
if (args[0] === '--version') {
  process.stdout.write('gh version 2.60.0 (brainstrike-e2e-shim)\\n');
} else if (args[0] === 'auth') {
  const at = args.indexOf('--hostname');
  const host = at === -1 ? '' : (args[at + 1] ?? '');
  if (!(process.env.${HOSTS_ENV} ?? '').split(' ').includes(host)) {
    fail('You are not logged into ' + host + '.');
  }
} else if (args[0] === 'pr') {
  process.stdout.write(readFileSync(process.env.${PR_FILE_ENV}, 'utf8'));
} else {
  fail('brainstrike-e2e gh shim: unsupported command ' + args[0]);
}
`;

/** One word for `sh`, single-quoted. */
const shellWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** Writes the `gh` that `execFile` finds in `dir`: a sh wrapper, or on Windows `gh.exe`. */
function writeGhExecutable(dir: string, script: string): void {
  if (process.platform === 'win32') {
    const config = path.join(dir, 'gh-sea.json');
    writeFileSync(
      config,
      JSON.stringify({
        disableExperimentalSEAWarning: true,
        main: script,
        output: path.join(dir, 'gh.exe'),
      }),
      'utf8'
    );
    execFileSync(process.execPath, ['--build-sea', config], { cwd: dir, stdio: 'pipe' });
    return;
  }
  const binary = path.join(dir, 'gh');
  writeFileSync(
    binary,
    `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(script)} "$@"\n`,
    'utf8'
  );
  chmodSync(binary, 0o755);
}

export function installGhShim(
  options: { readonly authenticatedHosts?: readonly string[] } = {}
): GhShim {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bst-gh-shim-'));
  const script = path.join(dir, 'gh-shim.cjs');
  const prFile = path.join(dir, 'pr.json');
  const logFile = path.join(dir, 'invocations.log');
  writeFileSync(prFile, '[]', 'utf8');
  writeFileSync(logFile, '', 'utf8');
  writeFileSync(script, SHIM, 'utf8');
  writeGhExecutable(dir, script);

  const previousPath = process.env['PATH'] ?? '';
  const previousPrFile = process.env[PR_FILE_ENV];
  const previousHosts = process.env[HOSTS_ENV];
  const previousLog = process.env[LOG_ENV];
  process.env['PATH'] = `${dir}${path.delimiter}${previousPath}`;
  process.env[PR_FILE_ENV] = prFile;
  process.env[HOSTS_ENV] = (options.authenticatedHosts ?? ['github.com']).join(' ');
  process.env[LOG_ENV] = logFile;

  return {
    dispose: () => {
      process.env['PATH'] = previousPath;
      if (previousPrFile === undefined) {
        Reflect.deleteProperty(process.env, PR_FILE_ENV);
      } else {
        process.env[PR_FILE_ENV] = previousPrFile;
      }
      if (previousHosts === undefined) {
        Reflect.deleteProperty(process.env, HOSTS_ENV);
      } else {
        process.env[HOSTS_ENV] = previousHosts;
      }
      if (previousLog === undefined) {
        Reflect.deleteProperty(process.env, LOG_ENV);
      } else {
        process.env[LOG_ENV] = previousLog;
      }
      rmSync(dir, { force: true, recursive: true });
    },
    readInvocations: () =>
      readFileSync(logFile, 'utf8')
        .split(`${LOG_SEPARATOR}\n`)
        .map((block) => block.split('\n').filter((line) => line.length > 0))
        .filter((argv) => argv.length > 0),
    setPullRequests: (rows) => {
      writeFileSync(prFile, JSON.stringify(rows), 'utf8');
    },
  };
}
