/**
 * BST-2454: a repository's own config can name `filter.<driver>.clean`,
 * `smudge` and `process` commands, and its `.gitattributes` points files at
 * them. Git runs them whenever it reads or writes the working tree: the
 * Changes listing, `git status`, stage, unstage and revert. A clone never
 * copies `.git/config`, but a folder unpacked from an archive or copied from
 * someone else carries its author's commands.
 *
 * Until the person trusts a folder (ADR-0032), every git command the host runs
 * there sets each filter command that came from the repository's own config to
 * empty, which git reads as no filter, and marks those drivers not required.
 * Filters from the person's global or system config, where `git lfs install`
 * writes Git LFS, keep working. A command in a trusted folder runs as is.
 */
import { isAbsolute } from 'node:path';
import {
  type HostWorkspaceTrustStore,
  readHostWorkspaceTrust,
} from '@brainstrike/agent-host/workspace-trust';
import { canonicalRoot } from '@brainstrike/state-store';
import type { WorkspaceRootResolver } from '../workspace-root-cwd.ts';
import type { GitCommandRun, GitCommandRunner } from './git-service.ts';
import { isPathWithin } from './worktree-paths.ts';

/** Every filter command key, whichever config file set it. */
const FILTER_COMMAND_KEYS = String.raw`^filter\..*\.(clean|smudge|process)$`;

/** The person's own config files; every other scope came with the repository. */
const PERSON_SCOPES = new Set(['global', 'system']);

/** Decodes only valid UTF-8, so a key is never rewritten into another key. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The overrides for `git config --null --show-scope --get-regexp` output, one
 * `scope NUL key LF value NUL` per entry: each repository-set filter command
 * emptied, then each of those drivers marked not required. Undefined when the
 * output is not valid UTF-8 or does not parse, so the caller fails rather than
 * run unguarded. A driver name with a byte that is not UTF-8 cannot be named
 * in the environment, where Node passes only UTF-8, so it has no override.
 */
function repositoryFilterOverrides(probeOutput: Buffer): [string, string][] | undefined {
  let text: string;
  try {
    text = strictUtf8.decode(probeOutput);
  } catch {
    return;
  }
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) {
    return;
  }
  const overrides: [string, string][] = [];
  const drivers = new Set<string>();
  for (let index = 0; index < fields.length; index += 2) {
    if (PERSON_SCOPES.has(fields[index] ?? '')) {
      continue;
    }
    // A config key never holds a newline; the value follows the first one.
    const key = (fields[index + 1] ?? '').split('\n', 1)[0] ?? '';
    overrides.push([key, '']);
    drivers.add(key.slice(0, key.lastIndexOf('.')));
  }
  for (const driver of drivers) {
    overrides.push([`${driver}.required`, 'false']);
  }
  return overrides;
}

/**
 * The overrides as command-scope config in the environment. Unlike `-c`, a
 * `GIT_CONFIG_KEY_<n>` is taken whole, so a driver named with `=` in it cannot
 * split the key and leave the real one in force.
 */
function withConfigOverrides(
  env: Readonly<Record<string, string>> | undefined,
  overrides: readonly [string, string][]
): Record<string, string> {
  const first = Number(env?.['GIT_CONFIG_COUNT'] ?? 0);
  const next: Record<string, string> = { ...env };
  next['GIT_CONFIG_COUNT'] = String(first + overrides.length);
  for (const [offset, [key, value]] of overrides.entries()) {
    next[`GIT_CONFIG_KEY_${first + offset}`] = key;
    next[`GIT_CONFIG_VALUE_${first + offset}`] = value;
  }
  return next;
}

/**
 * The run returned in place of the command when the repository's filters
 * cannot be turned off, so nothing runs with them on.
 */
const UNGUARDABLE_FILTERS = {
  exitCode: 128,
  stderr:
    "fatal: this folder's own git config names a filter that cannot be turned off, " +
    'so the command did not run; trust the folder or remove the filter\n',
  stdout: '',
  timedOut: false,
} as const satisfies GitCommandRun;

/** A failed probe as the command's run, without the probe's output. */
function probeFailure(probe: GitCommandRun): GitCommandRun {
  return {
    exitCode: probe.exitCode,
    ...(probe.failureReason === undefined ? {} : { failureReason: probe.failureReason }),
    stderr: probe.stderr,
    stdout: '',
    timedOut: probe.timedOut,
  };
}

/**
 * `run`, with the repository's own filter commands off wherever `isTrusted`
 * says no. Each untrusted command first reads the filter keys in its `cwd`,
 * because the config can change between commands. A failed or unreadable
 * probe fails the command, never treated as no filters.
 */
export function guardRepositoryFilters(options: {
  readonly isTrusted: (cwd: string) => Promise<boolean>;
  readonly run: GitCommandRunner;
}): GitCommandRunner {
  const { isTrusted, run } = options;
  return async (params) => {
    if (await isTrusted(params.cwd)) {
      return await run(params);
    }
    const probe = await run({
      args: ['config', '--null', '--show-scope', '--get-regexp', FILTER_COMMAND_KEYS],
      binaryStdout: true,
      cwd: params.cwd,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    });
    const output = probe.stdoutBuffer ?? Buffer.from(probe.stdout);
    if (probe.failureReason !== undefined) {
      return probeFailure(probe);
    }
    // Exit 1 with no output: no filter command is configured anywhere.
    if (probe.exitCode === 1 && output.length === 0) {
      return await run(params);
    }
    if (probe.exitCode !== 0) {
      return probeFailure(probe);
    }
    const overrides = repositoryFilterOverrides(output);
    if (!overrides) {
      return UNGUARDABLE_FILTERS;
    }
    return overrides.length === 0
      ? await run(params)
      : await run({ ...params, env: withConfigOverrides(params.env, overrides) });
  };
}

/** The folder's canonical path; undefined when it cannot be resolved, which trusts nothing. */
function canonicalFolder(folder: string): string | undefined {
  try {
    return canonicalRoot(folder);
  } catch {
    return;
  }
}

/**
 * True when `cwd` is a mounted folder the person trusted, or sits inside one.
 * Trusting a folder covers what is in it, as VS Code's Workspace Trust does.
 */
export function createTrustedFolderCheck(
  store: HostWorkspaceTrustStore,
  roots: WorkspaceRootResolver
): (cwd: string) => Promise<boolean> {
  return async (cwd) => {
    const folder = canonicalFolder(cwd);
    if (folder === undefined) {
      return false;
    }
    for (const root of await roots.listRoots()) {
      // A browser-backed root has no filesystem path to contain a git command.
      const rootFolder = isAbsolute(root.path) ? canonicalFolder(root.path) : undefined;
      if (
        rootFolder !== undefined &&
        isPathWithin(folder, rootFolder) &&
        (await readHostWorkspaceTrust(store, rootFolder)) === 'trusted'
      ) {
        return true;
      }
    }
    return false;
  };
}
