#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

const DEFAULT_TURBO_CACHE_MAX_BYTES = 25 * 1024 * 1024 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NESTED_TURBO_RUN_LOCK_DIRNAME = 'nested-turbo-run.lock';
const NESTED_RUN_LOCK_POLL_MS = 200;
const NESTED_RUN_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const DEV_DEPS_PREPARED_ENV = 'BRAINSTRIKE_DEV_DEPS_PREPARED';
const MAX_CACHE_NAMESPACE_BYTES = 255;
const CACHE_NAMESPACE_DIGEST_LENGTH = 12;

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function resolveGitWorktreeRoot(cwd = process.cwd(), options = {}) {
  const fileSystem = options.fs ?? fs;
  let current = fileSystem.realpathSync(cwd);

  // The nearest marker is intentional: nested repositories and submodules get
  // independent cache namespaces without spawning Git on every Turbo command.
  for (;;) {
    if (fileSystem.existsSync(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Unable to resolve a Git worktree root from ${cwd}. Set BRAINSTRIKE_TURBO_CACHE_DIR to run outside a Git worktree.`
      );
    }
    current = parent;
  }
}

function getWorktreeCacheNamespace(worktreeRoot) {
  const name = path.basename(worktreeRoot).replaceAll(/[^a-zA-Z0-9._-]/gu, '-') || 'worktree';
  const digest = createHash('sha256')
    .update(worktreeRoot)
    .digest('hex')
    .slice(0, CACHE_NAMESPACE_DIGEST_LENGTH);
  const maxNameLength = MAX_CACHE_NAMESPACE_BYTES - CACHE_NAMESPACE_DIGEST_LENGTH - 1;
  return `${name.slice(0, maxNameLength)}-${digest}`;
}

function resolveTurboWorkingDirectory(args, cwd) {
  let turboCwd = cwd;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--cwd') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--cwd requires a directory argument.');
      }
      turboCwd = path.resolve(cwd, value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length);
      if (!value) {
        throw new Error('--cwd requires a directory argument.');
      }
      turboCwd = path.resolve(cwd, value);
    }
  }
  return turboCwd;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Sharing one cache dir makes concurrent nested runs consistent, not
// serialized: turbo has no cross-process execution lock, so two nested runs
// (e.g. web and desktop predev under root `pnpm dev`) can both miss the same
// task hash on a cold cache and both execute it — including its `rimraf dist`
// — while the other is reading those outputs. Nested invocations therefore
// serialize behind this lock. Root invocations must NOT take it: the root run
// would hold it while its own nested children wait on it forever.
export function acquireNestedTurboRunLock(cacheDir, options = {}) {
  const {
    fs: fileSystem = fs,
    isProcessAlive: isProcessAliveImpl = isProcessAlive,
    log = console.log,
    pid = process.pid,
    pollMs = NESTED_RUN_LOCK_POLL_MS,
    sleep = sleepSync,
    timeoutMs = NESTED_RUN_LOCK_TIMEOUT_MS,
  } = options;

  const lockDir = path.join(cacheDir, NESTED_TURBO_RUN_LOCK_DIRNAME);
  const pidFile = path.join(lockDir, 'pid');
  let waitedMs = 0;
  let announcedWait = false;

  for (;;) {
    try {
      fileSystem.mkdirSync(lockDir);
      fileSystem.writeFileSync(pidFile, String(pid));
      return () => {
        fileSystem.rmSync(lockDir, { force: true, recursive: true });
      };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error;
      }
    }

    let holderPid;
    try {
      holderPid = Number.parseInt(fileSystem.readFileSync(pidFile, 'utf8'), 10);
    } catch {
      // The holder is mid-acquisition (or just released); treat as held and
      // re-contend on the next iteration.
      holderPid = Number.NaN;
    }

    if (Number.isSafeInteger(holderPid) && !isProcessAliveImpl(holderPid)) {
      // Rename-then-remove so concurrent waiters cannot double-steal: rename
      // is atomic, so exactly one waiter moves the stale dir aside; the rest
      // hit ENOENT here and re-contend on mkdir.
      const staleDir = `${lockDir}.stale-${pid}`;
      try {
        fileSystem.renameSync(lockDir, staleDir);
        fileSystem.rmSync(staleDir, { force: true, recursive: true });
        log(`Removed stale nested-turbo run lock held by dead pid ${holderPid}.`);
      } catch {
        // Another waiter stole it first; fall through and re-contend.
      }
      continue;
    }

    if (waitedMs >= timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the nested-turbo run lock at ${lockDir} (held by pid ${holderPid}). If that process is wedged, kill it; the next run steals locks from dead holders automatically.`
      );
    }
    if (!announcedWait) {
      log(
        `Waiting for a concurrent nested turbo run to finish (lock ${lockDir}, held by pid ${holderPid}).`
      );
      announcedWait = true;
    }
    sleep(pollMs);
    waitedMs += pollMs;
  }
}

export function resolveTurboCacheDir({
  cwd = process.cwd(),
  env = process.env,
  fs: fileSystem = fs,
  platform = process.platform,
} = {}) {
  const configuredCacheDir = env['TURBO_CACHE_DIR'] || env['BRAINSTRIKE_TURBO_CACHE_DIR'];
  if (configuredCacheDir) {
    return configuredCacheDir;
  }

  const worktreeRoot = resolveGitWorktreeRoot(cwd, { fs: fileSystem });
  const namespace = getWorktreeCacheNamespace(worktreeRoot);

  if (platform === 'darwin') {
    const home = env['HOME'];
    if (!home) {
      throw new Error('HOME is required to resolve the default Turborepo cache directory.');
    }
    return path.join(home, 'Library', 'Caches', 'BrainStrike', 'turbo', 'worktrees', namespace);
  }

  const xdgCacheHome = env['XDG_CACHE_HOME'];
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, 'brainstrike', 'turbo', 'worktrees', namespace);
  }

  const home = env['HOME'] || env['USERPROFILE'];
  if (!home) {
    throw new Error(
      'HOME, USERPROFILE, or XDG_CACHE_HOME is required to resolve the Turborepo cache directory.'
    );
  }
  return path.join(home, '.cache', 'brainstrike', 'turbo', 'worktrees', namespace);
}

export function buildTurboArgs(args, options = {}) {
  if (args.some((arg) => arg === '--cache-dir' || arg.startsWith('--cache-dir='))) {
    return [...args];
  }

  const cwd = options.cwd ?? process.cwd();
  const cacheDir = resolveTurboCacheDir({
    ...options,
    cwd: resolveTurboWorkingDirectory(args, cwd),
  });
  return [...args, `--cache-dir=${cacheDir}`];
}

export function planTurboCachePrune(entries, maxBytes) {
  let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes <= maxBytes) {
    return [];
  }

  const deletions = [];
  const oldestFirst = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of oldestFirst) {
    if (totalBytes <= maxBytes) {
      break;
    }
    deletions.push(entry.path);
    totalBytes -= entry.size;
  }

  return deletions;
}

function resolveTurboCacheMaxBytes(env = process.env) {
  const raw = env['BRAINSTRIKE_TURBO_CACHE_MAX_BYTES'];
  if (!raw) {
    return DEFAULT_TURBO_CACHE_MAX_BYTES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== raw || parsed <= 0) {
    throw new Error('BRAINSTRIKE_TURBO_CACHE_MAX_BYTES must be a positive integer byte count.');
  }
  return parsed;
}

export function collectCacheFiles(cacheDir, options = {}) {
  const fileSystem = options.fs ?? fs;
  if (!fileSystem.existsSync(cacheDir)) {
    return [];
  }

  const files = [];
  const stack = [cacheDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fileSystem.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      let stats;
      try {
        stats = fileSystem.lstatSync(entryPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      files.push({ mtimeMs: stats.mtimeMs, path: entryPath, size: stats.size });
    }
  }

  return files;
}

export function pruneTurboCache(cacheDir, env = process.env, options = {}) {
  const fileSystem = options.fs ?? fs;
  const warn = options.warn ?? console.warn;
  let maxBytes;
  try {
    maxBytes = resolveTurboCacheMaxBytes(env);
  } catch (error) {
    warn(
      `Skipped Turborepo cache pruning: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const files = collectCacheFiles(cacheDir, { fs: fileSystem });
  for (const filePath of planTurboCachePrune(files, maxBytes)) {
    try {
      fileSystem.rmSync(filePath, { force: true });
    } catch (error) {
      warn(
        `Skipped Turborepo cache entry prune for ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export function getCacheDirFromArgs(args, rootDir = REPO_ROOT) {
  const cacheDirIndex = args.indexOf('--cache-dir');
  if (cacheDirIndex !== -1) {
    const cacheDir = args[cacheDirIndex + 1];
    if (!cacheDir) {
      throw new Error('--cache-dir requires a directory argument.');
    }
    return path.resolve(rootDir, cacheDir);
  }

  const cacheDirArg = args.find((arg) => arg.startsWith('--cache-dir='));
  if (!cacheDirArg) {
    throw new Error('Internal error: Turborepo cache directory was not configured.');
  }
  return path.resolve(rootDir, cacheDirArg.slice('--cache-dir='.length));
}

export function runTurboCommand(argv = process.argv, platform = process.platform, options = {}) {
  const {
    env = process.env,
    log = console.log,
    logError = console.error,
    spawnSyncImpl = spawnSync,
  } = options;
  const separatorIndex = argv.indexOf('--');

  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    logError(
      'Usage: node scripts/run-turbo-command.mjs [--windows-concurrency=N] [--skip-under-turbo] [--skip-under-prepared-dev] [--mark-dev-deps-prepared] -- <turbo args...>'
    );
    return 1;
  }

  let windowsConcurrency;
  let skipUnderTurbo = false;
  let skipUnderPreparedDev = false;
  let markDevDepsPrepared = false;

  for (const option of argv.slice(2, separatorIndex)) {
    if (option === '--skip-under-turbo') {
      skipUnderTurbo = true;
      continue;
    }

    if (option === '--skip-under-prepared-dev') {
      skipUnderPreparedDev = true;
      continue;
    }

    if (option === '--mark-dev-deps-prepared') {
      markDevDepsPrepared = true;
      continue;
    }

    if (option.startsWith('--windows-concurrency=')) {
      windowsConcurrency = option.slice('--windows-concurrency='.length);
      continue;
    }

    logError(`Unknown option: ${option}`);
    return 1;
  }

  // Opt-in for app `prebuild` scripts ONLY (contract-tested in
  // scripts/__tests__/run-turbo-command.test.mjs): when an outer turbo task is
  // running this script, that task's `dependsOn: ["^build"]` has already built
  // every package this invocation would filter, so re-entering turbo is pure
  // duplication — and a data race: this nested run may resolve a different
  // cache directory than the outer run, so the same task hash can miss here
  // after hitting outside, and the
  // re-executed build's `rimraf dist` deletes outputs that concurrently
  // running sibling tasks (e.g. web's vite config-load) are importing.
  // TURBO_HASH is injected by turbo into every task's environment and is the
  // documented way to detect running under turbo. Scripts without the ^build
  // guarantee (e.g. predev under `turbo run dev`) must NOT pass this flag.
  // Known caveats (accepted, not silently ignorable — both degrade LOUDLY or
  // by explicit operator choice):
  // - `turbo run build --filter=<app> --only` still sets TURBO_HASH but runs
  //   no dependency tasks. There is no env signal for --only, so the skip
  //   cannot detect it; --only is an explicit operator opt-out of dependency
  //   tasks (no repo script uses it), and a missing dist then fails loudly at
  //   config load rather than building silently.
  // - If a turbo upgrade ever stops exporting TURBO_HASH, prebuild reverts to
  //   re-entering turbo — the pre-#2132 racy-but-building behavior, visible as
  //   nested "cache miss, executing" lines in build logs, not a silent no-op.
  if (skipUnderTurbo && env['TURBO_HASH']) {
    log(
      'Skipping nested turbo invocation (--skip-under-turbo): TURBO_HASH is set, so an outer turbo task is running this script and its ^build graph already builds these packages.'
    );
    return 0;
  }

  // App predev hooks may skip only when root predev completed synchronous
  // dependency preparation and explicitly marked the outer dev graph.
  // TURBO_HASH alone merely proves Turbo is running; direct `turbo run dev`
  // must fail closed rather than launch nested builds beside live watchers.
  if (skipUnderPreparedDev && env['TURBO_HASH']) {
    if (env[DEV_DEPS_PREPARED_ENV] !== '1') {
      logError(
        `Refusing to start dev without synchronous dependency preparation. Run \`pnpm dev\` instead of invoking Turbo directly; if you already ran \`pnpm dev\`, verify dev.passThroughEnv in turbo.jsonc includes ${DEV_DEPS_PREPARED_ENV}.`
      );
      return 1;
    }
    log(
      `Skipping nested dev dependency build: root predev completed it before the outer watcher graph (${DEV_DEPS_PREPARED_ENV}=1).`
    );
    return 0;
  }

  let args = argv.slice(separatorIndex + 1);

  if (platform === 'win32' && windowsConcurrency) {
    const concurrencyIndex = args.findIndex(
      (arg) => arg === '--concurrency' || arg.startsWith('--concurrency=')
    );

    if (concurrencyIndex === -1) {
      args.push(`--concurrency=${windowsConcurrency}`);
    } else if (args[concurrencyIndex] === '--concurrency') {
      args.splice(concurrencyIndex, 2, '--concurrency', windowsConcurrency);
    } else {
      args[concurrencyIndex] = `--concurrency=${windowsConcurrency}`;
    }
  }

  try {
    args = buildTurboArgs(args, { cwd: process.cwd(), env, platform });
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const cacheDir = getCacheDirFromArgs(args);
  fs.mkdirSync(cacheDir, { recursive: true });

  // TURBO_HASH ⇒ an outer turbo task is running this script, so sibling
  // nested runs may be executing concurrently — serialize them (see
  // acquireNestedTurboRunLock). Root invocations skip the lock.
  let releaseNestedRunLock;
  if (env['TURBO_HASH']) {
    try {
      releaseNestedRunLock = acquireNestedTurboRunLock(cacheDir, { log });
    } catch (error) {
      logError(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const invocation = createSpawnInvocation('turbo', args, platform);
    const result = spawnSyncImpl(invocation.command, invocation.args, {
      env: markDevDepsPrepared ? { ...env, [DEV_DEPS_PREPARED_ENV]: '1' } : env,
      shell: invocation.shell,
      stdio: 'inherit',
    });

    if (result.error) {
      logError(result.error.message);
      return 1;
    }

    const status = result.status ?? 1;
    if (status !== 0) {
      return status;
    }

    pruneTurboCache(cacheDir, env);

    return 0;
  } finally {
    releaseNestedRunLock?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runTurboCommand());
}
