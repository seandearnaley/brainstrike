#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  let current = path.dirname(path.resolve(filePath));
  const root = path.parse(current).root;
  while (current !== root) {
    if (existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function sourcePackageRoot(source, roots) {
  for (const root of roots) {
    const relative = path.relative(path.resolve(root), source);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      continue;
    }
    const owner = path.resolve(root, relative.split(path.sep)[0]);
    if (existsSync(path.join(owner, 'package.json'))) {
      return owner;
    }
  }
  throw new Error(`Coverage source is outside the workspace packages: ${source}`);
}

function groupCoverageFiles(roots) {
  const groups = new Map();
  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    for (const file of walk(root)) {
      const reportOwner = findPackageRoot(file);
      if (!reportOwner) {
        continue;
      }
      // Desktop still exercises shared modules extracted into Core. Credit the
      // actual source owner, retaining its uncovered entries and existing floor.
      const partitions = new Map([[reportOwner, {}]]);
      for (const [source, coverage] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
        const owner = sourcePackageRoot(source, roots);
        const entries = partitions.get(owner) ?? {};
        entries[source] = coverage;
        partitions.set(owner, entries);
      }
      for (const [owner, entries] of partitions) {
        const inputs = groups.get(owner) ?? [];
        inputs.push({ entries, file, reportOwner });
        groups.set(owner, inputs);
      }
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

  if (
    files.length === 1 &&
    path.resolve(files[0].file) === path.resolve(canonicalFile) &&
    Object.keys(files[0].entries).length ===
      Object.keys(JSON.parse(readFileSync(canonicalFile, 'utf8'))).length
  ) {
    return { cleaned: 0, files: 1, merged: false, packageRoot };
  }

  const inputDir = path.join(tempRoot, safeName(packageRoot));
  rmSync(inputDir, { force: true, recursive: true });
  mkdirSync(inputDir, { recursive: true });

  files.forEach(({ entries }, index) => {
    writeFileSync(path.join(inputDir, `${index}.json`), JSON.stringify(entries));
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
  for (const { file, reportOwner } of files) {
    if (reportOwner !== packageRoot || path.resolve(file) === path.resolve(canonicalFile)) {
      continue;
    }
    const reportDir = path.dirname(file);
    if (path.basename(reportDir).startsWith('coverage-')) {
      rmSync(reportDir, { force: true, recursive: true });
      cleaned += 1;
    }
  }

  return { cleaned, files: files.length, merged: true, packageRoot };
}

export function prepareWorkspaceCoverage({ roots = ['packages', 'apps'] } = {}) {
  const groups = groupCoverageFiles(roots);
  const tempRoot = path.resolve('.nyc_output', 'workspace-coverage-inputs');
  rmSync(tempRoot, { force: true, recursive: true });
  mkdirSync(tempRoot, { recursive: true });

  const results = [];
  for (const [packageRoot, files] of [...groups.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    results.push(mergePackageCoverage(packageRoot, files, tempRoot));
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
