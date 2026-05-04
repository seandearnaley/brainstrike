#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const SKIPPED_DIRECTORIES = new Set(['.git', '.turbo', 'node_modules']);

function walk(dir) {
  const files = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      files.push(...walk(entryPath));
    } else if (entry.isFile() && entry.name === 'coverage-final.json') {
      files.push(entryPath);
    }
  }
  return files;
}

function findPackageRoot(filePath) {
  let current = path.dirname(filePath);
  const root = path.parse(current).root;
  while (current !== root) {
    if (existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function groupCoverageFiles(roots) {
  const groups = new Map();
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    for (const file of walk(root)) {
      const packageRoot = findPackageRoot(file);
      if (!packageRoot) {
        continue;
      }
      const files = groups.get(packageRoot) ?? [];
      files.push(file);
      groups.set(packageRoot, files);
    }
  }
  return groups;
}

function safeName(packageRoot) {
  return path
    .relative(process.cwd(), packageRoot)
    .replaceAll(path.sep, '__')
    .replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
}

function mergePackageCoverage(packageRoot, files, tempRoot) {
  const canonicalDir = path.join(packageRoot, 'coverage');
  const canonicalFile = path.join(canonicalDir, 'coverage-final.json');
  mkdirSync(canonicalDir, { recursive: true });

  if (files.length === 1 && path.resolve(files[0]) === path.resolve(canonicalFile)) {
    return { cleaned: 0, packageRoot, files: 1, merged: false };
  }

  const inputDir = path.join(tempRoot, safeName(packageRoot));
  rmSync(inputDir, { recursive: true, force: true });
  mkdirSync(inputDir, { recursive: true });

  files.forEach((file, index) => {
    cpSync(file, path.join(inputDir, `${index}.json`));
  });

  const result = spawnSync('pnpm', ['exec', 'nyc', 'merge', inputDir, canonicalFile], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    if (result.stdout) {
      console.error(result.stdout.trim());
    }
    if (result.stderr) {
      console.error(result.stderr.trim());
    }
    throw new Error(`Failed to merge coverage for ${path.relative(process.cwd(), packageRoot)}`);
  }

  let cleaned = 0;
  for (const file of files) {
    if (path.resolve(file) === path.resolve(canonicalFile)) {
      continue;
    }
    const reportDir = path.dirname(file);
    if (path.basename(reportDir).startsWith('coverage-')) {
      rmSync(reportDir, { force: true, recursive: true });
      cleaned += 1;
    }
  }

  return { cleaned, packageRoot, files: files.length, merged: true };
}

export function prepareWorkspaceCoverage({ roots = ['packages', 'apps'] } = {}) {
  const groups = groupCoverageFiles(roots);
  const tempRoot = path.resolve('.nyc_output', 'workspace-coverage-inputs');
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  const results = [];
  for (const [packageRoot, files] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    results.push(mergePackageCoverage(packageRoot, files.sort(), tempRoot));
  }
  return results;
}

function main() {
  const results = prepareWorkspaceCoverage();
  for (const result of results) {
    const rel = path.relative(process.cwd(), result.packageRoot);
    const action = result.merged ? 'merged' : 'kept';
    const cleanup = result.cleaned > 0 ? `; removed ${result.cleaned} split report dir(s)` : '';
    console.log(`${action} ${result.files} coverage report(s) for ${rel}${cleanup}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
