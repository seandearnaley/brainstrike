#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_TURBO_CACHE_MAX_BYTES = 25 * 1024 * 1024 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Match turbo-boundaries.mjs: the installed Node entrypoint needs neither PATH
// discovery nor a Windows .cmd shim/shell.
const TURBO_ENTRY = path.join(REPO_ROOT, 'node_modules', 'turbo', 'bin', 'turbo');
const MAX_CACHE_NAMESPACE_BYTES = 255;
const CACHE_NAMESPACE_DIGEST_LENGTH = 12;

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

/**
 * Turbo runs `--concurrency=N` Vitest processes at once and each one sizes its
 * pool from the whole host, so the cores are split between them through
 * Vitest's own VITEST_MAX_WORKERS. An explicit value wins.
 */
export function resolveVitestMaxWorkers(
  args,
  env = process.env,
  cores = os.availableParallelism()
) {
  if (env['VITEST_MAX_WORKERS']) {
    return;
  }
  const flagIndex = args.findIndex(
    (arg) => arg === '--concurrency' || arg.startsWith('--concurrency=')
  );
  if (flagIndex === -1) {
    return;
  }
  const value =
    args[flagIndex] === '--concurrency'
      ? args[flagIndex + 1]
      : args[flagIndex].slice('--concurrency='.length);
  const tasks = Number(value);
  if (!Number.isInteger(tasks) || tasks < 1) {
    return;
  }
  return String(Math.max(1, Math.floor(cores / tasks)));
}

export function runTurboCommand(argv = process.argv, platform = process.platform, options = {}) {
  const { env = process.env, logError = console.error, spawnSyncImpl = spawnSync } = options;
  const separatorIndex = argv.indexOf('--');

  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    logError('Usage: node scripts/run-turbo-command.mjs -- <turbo args...>');
    return 1;
  }

  const [unknownOption] = argv.slice(2, separatorIndex);
  if (unknownOption !== undefined) {
    logError(`Unknown option: ${unknownOption}`);
    return 1;
  }

  let args = argv.slice(separatorIndex + 1);

  const vitestMaxWorkers = resolveVitestMaxWorkers(args, env);
  const taskEnv = vitestMaxWorkers ? { ...env, VITEST_MAX_WORKERS: vitestMaxWorkers } : env;

  try {
    args = buildTurboArgs(args, { cwd: process.cwd(), env, platform });
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const cacheDir = getCacheDirFromArgs(args);
  fs.mkdirSync(cacheDir, { recursive: true });

  const result = spawnSyncImpl(process.execPath, [TURBO_ENTRY, ...args], {
    env: taskEnv,
    shell: false,
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
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runTurboCommand());
}
