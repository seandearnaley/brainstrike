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
 *
 * Git also runs `git status` inside every checked-out submodule, and inside a
 * repository cloned within this one, for the Changes listing and for a stage
 * with no paths named. Those repositories came in the same folder, so their
 * own filter commands are emptied too; command-scope config reaches the git
 * processes git starts in them.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
 * The repository-set filter command keys in `git config --null --show-scope
 * --get-regexp` output, one `scope NUL key LF value NUL` per entry. Undefined
 * when the output is not valid UTF-8 or does not parse, so the caller fails
 * rather than run unguarded. A driver name with a byte that is not UTF-8
 * cannot be named in the environment, where Node passes only UTF-8.
 */
function repositoryFilterKeys(probeOutput: Buffer): string[] | undefined {
  const fields = nulFields(probeOutput);
  if (fields === undefined || fields.length % 2 !== 0) {
    return;
  }
  const keys: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!PERSON_SCOPES.has(fields[index] ?? '')) {
      // A config key never holds a newline; the value follows the first one.
      keys.push((fields[index + 1] ?? '').split('\n', 1)[0] ?? '');
    }
  }
  return keys;
}

/** NUL-terminated fields, or undefined when the bytes are not UTF-8 or end mid-field. */
function nulFields(output: Buffer): string[] | undefined {
  let text: string;
  try {
    text = strictUtf8.decode(output);
  } catch {
    return;
  }
  const fields = text.split('\0');
  return fields.pop() === '' ? fields : undefined;
}

/** One line of output without its line ending, or undefined when it is not UTF-8. */
function decodedLine(output: Buffer): string | undefined {
  try {
    return strictUtf8.decode(output).replace(/\r?\n$/u, '');
  } catch {
    return;
  }
}

/** Each key emptied, then each of their drivers marked not required. */
function filterOverrides(keys: ReadonlySet<string>): [string, string][] {
  const overrides: [string, string][] = [];
  const drivers = new Set<string>();
  for (const key of keys) {
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

/** Every repository git can enter from one command, the command's own first. */
const MAX_NESTING = 8;

/** One git read the guard needs, or the run that fails the command in its place. */
type GuardRead<T> = { readonly failed: GitCommandRun } | { readonly value: T };

type ReadParams = Pick<Parameters<GitCommandRunner>[0], 'signal' | 'timeoutMs'>;

/** A git read's exit code and raw output; a run that did not finish fails the command. */
async function readGit(
  run: GitCommandRunner,
  args: readonly string[],
  cwd: string,
  params: ReadParams
): Promise<
  GuardRead<{
    readonly exitCode: number | null;
    readonly output: Buffer;
    readonly read: GitCommandRun;
  }>
> {
  const read = await run({
    args,
    binaryStdout: true,
    cwd,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  if (read.failureReason !== undefined) {
    return { failed: probeFailure(read) };
  }
  return {
    value: { exitCode: read.exitCode, output: read.stdoutBuffer ?? Buffer.from(read.stdout), read },
  };
}

/** The filter command keys that the repository at `cwd` set itself. */
async function readRepositoryFilterKeys(
  run: GitCommandRunner,
  cwd: string,
  params: ReadParams
): Promise<GuardRead<string[]>> {
  const args = ['config', '--null', '--show-scope', '--get-regexp', FILTER_COMMAND_KEYS];
  const read = await readGit(run, args, cwd, params);
  if ('failed' in read) {
    return read;
  }
  const { exitCode, output } = read.value;
  // Exit 1 with no output: no filter command is configured anywhere.
  if (exitCode === 1 && output.length === 0) {
    return { value: [] };
  }
  if (exitCode !== 0) {
    return { failed: probeFailure(read.value.read) };
  }
  const keys = repositoryFilterKeys(output);
  return keys === undefined ? { failed: UNGUARDABLE_FILTERS } : { value: keys };
}

/**
 * The checked-out submodules of the repository at `cwd`, or undefined when
 * `git submodule foreach` stops, as it does at a gitlink with no
 * `.gitmodules` entry.
 */
async function readSubmodules(
  run: GitCommandRunner,
  cwd: string,
  params: ReadParams
): Promise<GuardRead<string[] | undefined>> {
  const args = ['submodule', 'foreach', '--quiet', 'printf "%s\\0" "$displaypath"'];
  const read = await readGit(run, args, cwd, params);
  if ('failed' in read || read.value.exitCode !== 0) {
    return 'failed' in read ? read : { value: undefined };
  }
  const paths = nulFields(read.value.output);
  return paths === undefined
    ? { failed: UNGUARDABLE_FILTERS }
    : { value: paths.map((entry) => resolve(cwd, entry)) };
}

/**
 * The checked-out gitlinks in the index of the repository at `cwd`, which
 * include a repository cloned inside it. A folder with no index to read has
 * no gitlink for git to enter. The runner pins literal pathspecs, so the
 * index is listed from the repository's top.
 */
async function readIndexGitlinks(
  run: GitCommandRunner,
  cwd: string,
  params: ReadParams
): Promise<GuardRead<string[]>> {
  const top = await readGit(run, ['rev-parse', '--show-toplevel'], cwd, params);
  if ('failed' in top || top.value.exitCode !== 0) {
    return 'failed' in top ? top : { value: [] };
  }
  const topFolder = decodedLine(top.value.output);
  if (!topFolder) {
    return { failed: UNGUARDABLE_FILTERS };
  }
  const index = await readGit(run, ['ls-files', '-z', '--stage'], topFolder, params);
  if ('failed' in index || index.value.exitCode !== 0) {
    return 'failed' in index ? index : { value: [] };
  }
  const entries = nulFields(index.value.output);
  if (entries === undefined) {
    return { failed: UNGUARDABLE_FILTERS };
  }
  // `<mode> <object> <stage>\t<path>`; mode 160000 is a gitlink.
  return {
    value: entries
      .filter((entry) => entry.startsWith('160000 ') && entry.includes('\t'))
      .map((entry) => resolve(topFolder, entry.slice(entry.indexOf('\t') + 1)))
      .filter((folder) => existsSync(join(folder, '.git'))),
  };
}

/**
 * The checked-out repositories git enters from `cwd`: its submodules, and any
 * repository cloned inside it that the index records as a gitlink, which
 * `git status` enters as well.
 */
async function readNestedRepositories(
  run: GitCommandRunner,
  cwd: string,
  params: ReadParams
): Promise<GuardRead<string[]>> {
  const submodules = await readSubmodules(run, cwd, params);
  if ('failed' in submodules || submodules.value !== undefined) {
    return submodules as GuardRead<string[]>;
  }
  return await readIndexGitlinks(run, cwd, params);
}

/**
 * The repository-set filter command keys of the repository at `cwd` and of
 * every checked-out repository git can enter from it, however deep.
 */
async function readReachableFilterKeys(
  run: GitCommandRunner,
  cwd: string,
  params: ReadParams
): Promise<GuardRead<Set<string>>> {
  const keys = new Set<string>();
  const seen = new Set<string>([resolve(cwd)]);
  const queue = [{ depth: 0, folder: cwd }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (next.depth > MAX_NESTING) {
      return { failed: UNGUARDABLE_FILTERS };
    }
    const own = await readRepositoryFilterKeys(run, next.folder, params);
    const nested = 'failed' in own ? own : await readNestedRepositories(run, next.folder, params);
    if ('failed' in own || 'failed' in nested) {
      return 'failed' in own ? own : (nested as { readonly failed: GitCommandRun });
    }
    for (const key of own.value) {
      keys.add(key);
    }
    for (const folder of nested.value.filter((repository) => !seen.has(repository))) {
      seen.add(folder);
      queue.push({ depth: next.depth + 1, folder });
    }
  }
  return { value: keys };
}

/**
 * `run`, with the repository's own filter commands off wherever `isTrusted`
 * says no, in it and in every repository git enters from it. Each untrusted
 * command first reads the filter keys again, because the config can change
 * between commands. A failed or unreadable read fails the command, never
 * treated as no filters.
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
    const keys = await readReachableFilterKeys(run, params.cwd, params);
    if ('failed' in keys) {
      return keys.failed;
    }
    return keys.value.size === 0
      ? await run(params)
      : await run({ ...params, env: withConfigOverrides(params.env, filterOverrides(keys.value)) });
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
 * Trusting a folder covers what is in it, as VS Code's Workspace Trust does,
 * except a mounted folder inside it that the person kept restricted: the
 * nearest folder holding `cwd` that has an answer decides.
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
    const holding: string[] = [];
    for (const root of await roots.listRoots()) {
      // A browser-backed root has no filesystem path to contain a git command.
      const rootFolder = isAbsolute(root.path) ? canonicalFolder(root.path) : undefined;
      if (rootFolder !== undefined && isPathWithin(folder, rootFolder)) {
        holding.push(rootFolder);
      }
    }
    // Nearest first: a longer canonical path holding `cwd` sits inside a shorter one.
    holding.sort((left, right) => right.length - left.length);
    for (const rootFolder of holding) {
      const answer = await readHostWorkspaceTrust(store, rootFolder);
      if (answer !== 'undecided') {
        return answer === 'trusted';
      }
    }
    return false;
  };
}
