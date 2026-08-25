/**
 * A fake `gh` on PATH for desktop E2E (spec §14).
 *
 * TEST-ONLY, and deliberately outside the product: the shim is a real
 * executable named `gh`, so `execFileGhRunner` resolves it exactly the way it
 * resolves the real binary — the pinned environment, the argument array, the
 * exit-code classification and the JSON parsing are all under test.
 *
 * Scope: prepending to `process.env.PATH` is process-global for the Playwright
 * WORKER. Playwright runs each test FILE in its own worker, so a file-scoped
 * install/dispose pair cannot leak into another file; `dispose()` restores the
 * previous PATH regardless.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PR_FILE_ENV = 'BRAINSTRIKE_E2E_GH_PR_JSON';
const HOSTS_ENV = 'BRAINSTRIKE_E2E_GH_HOSTS';

export interface GhShim {
  readonly dispose: () => void;
  /** Replace what `gh pr list --json …` prints. Takes effect on the next call. */
  readonly setPullRequests: (rows: readonly unknown[]) => void;
}

const SCRIPT = `#!/bin/sh
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
  writeFileSync(prFile, '[]', 'utf8');
  writeFileSync(binary, SCRIPT, 'utf8');
  chmodSync(binary, 0o755);

  const previousPath = process.env['PATH'] ?? '';
  const previousPrFile = process.env[PR_FILE_ENV];
  const previousHosts = process.env[HOSTS_ENV];
  process.env['PATH'] = `${dir}${path.delimiter}${previousPath}`;
  process.env[PR_FILE_ENV] = prFile;
  process.env[HOSTS_ENV] = (options.authenticatedHosts ?? ['github.com']).join(' ');

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
      rmSync(dir, { force: true, recursive: true });
    },
    setPullRequests: (rows) => {
      writeFileSync(prFile, JSON.stringify(rows), 'utf8');
    },
  };
}
