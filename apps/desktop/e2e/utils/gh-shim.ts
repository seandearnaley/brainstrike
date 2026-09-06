/**
 * A fake `gh` on PATH for desktop E2E (spec §14).
 *
 * TEST-ONLY, and deliberately outside the product: the shim is a real
 * executable named `gh`, so `execFileGhRunner` resolves it exactly the way it
 * resolves the real binary — the pinned environment, the argument array, the
 * exit-code classification and the JSON parsing are all under test.
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

const SCRIPT = `#!/bin/sh
printf '%s\\n' "$@" >> "$${LOG_ENV}"
echo "${LOG_SEPARATOR}" >> "$${LOG_ENV}"
case "$1" in
  --version) echo "gh version 2.60.0 (brainstrike-e2e-shim)"; exit 0 ;;
  auth)
    host=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--hostname" ]; then host="$2"; fi
      shift
    done
    case " $${HOSTS_ENV} " in
      *" $host "*) exit 0 ;;
      *) echo "You are not logged into $host." 1>&2; exit 1 ;;
    esac ;;
  pr) cat "$${PR_FILE_ENV}"; exit 0 ;;
  *) echo "brainstrike-e2e gh shim: unsupported command $1" 1>&2; exit 1 ;;
esac
`;

export function installGhShim(
  options: { readonly authenticatedHosts?: readonly string[] } = {}
): GhShim {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bst-gh-shim-'));
  const binary = path.join(dir, 'gh');
  const prFile = path.join(dir, 'pr.json');
  const logFile = path.join(dir, 'invocations.log');
  writeFileSync(prFile, '[]', 'utf8');
  writeFileSync(logFile, '', 'utf8');
  writeFileSync(binary, SCRIPT, 'utf8');
  chmodSync(binary, 0o755);

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
