#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

const DEFAULT_TURBO_CACHE_MAX_BYTES = 25 * 1024 * 1024 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveTurboCacheDir({ env = process.env, platform = process.platform } = {}) {
  const configuredCacheDir = env['TURBO_CACHE_DIR'] || env['BRAINSTRIKE_TURBO_CACHE_DIR'];
  if (configuredCacheDir) {
    return configuredCacheDir;
  }

  if (platform === 'darwin') {
    const home = env['HOME'];
    if (!home) {
      throw new Error('HOME is required to resolve the default Turborepo cache directory.');
    }
    return path.join(home, 'Library', 'Caches', 'BrainStrike', 'turbo');
  }

  const xdgCacheHome = env['XDG_CACHE_HOME'];
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, 'brainstrike', 'turbo');
  }

  const home = env['HOME'] || env['USERPROFILE'];
  if (!home) {
    throw new Error(
      'HOME, USERPROFILE, or XDG_CACHE_HOME is required to resolve the Turborepo cache directory.'
    );
  }
  return path.join(home, '.cache', 'brainstrike', 'turbo');
}

export function buildTurboArgs(args, options = {}) {
  if (args.some((arg) => arg === '--cache-dir' || arg.startsWith('--cache-dir='))) {
    return [...args];
  }

  const cacheDir = resolveTurboCacheDir(options);
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

export function runTurboCommand(argv = process.argv, platform = process.platform) {
  const separatorIndex = argv.indexOf('--');

  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    console.error(
      'Usage: node scripts/run-turbo-command.mjs [--windows-concurrency=N] -- <turbo args...>'
    );
    return 1;
  }

  let windowsConcurrency;

  for (const option of argv.slice(2, separatorIndex)) {
    if (option.startsWith('--windows-concurrency=')) {
      windowsConcurrency = option.slice('--windows-concurrency='.length);
      continue;
    }

    console.error(`Unknown option: ${option}`);
    return 1;
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
    args = buildTurboArgs(args, { cwd: process.cwd(), env: process.env, platform });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const cacheDir = getCacheDirFromArgs(args);
  fs.mkdirSync(cacheDir, { recursive: true });

  const invocation = createSpawnInvocation('turbo', args, platform);
  const result = spawnSync(invocation.command, invocation.args, {
    env: process.env,
    shell: invocation.shell,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  const status = result.status ?? 1;
  if (status !== 0) {
    return status;
  }

  pruneTurboCache(cacheDir, process.env);

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runTurboCommand());
}
