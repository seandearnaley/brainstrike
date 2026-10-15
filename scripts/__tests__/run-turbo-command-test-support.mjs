import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { isForeignCheckout, REPO_ROOT_IGNORED_DIRECTORIES } from '../lib/repo-root-walk.mjs';

const require = createRequire(import.meta.url);

export function resolvedBuildPackages(turboArgs) {
  const dryRun = JSON.parse(
    execFileSync(
      process.execPath,
      [require.resolve('turbo/bin/turbo'), ...turboArgs, '--dry=json'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NO_UPDATE_NOTIFIER: '1',
          TURBO_TELEMETRY_DISABLED: '1',
        },
        maxBuffer: 64 * 1024 * 1024,
      }
    )
  );
  return dryRun.tasks
    .filter((task) => task.task === 'build' && task.command !== '<NONEXISTENT>')
    .map((task) => task.package);
}

export function packageScriptEntries() {
  return findPackageJsonFiles(process.cwd()).flatMap((packageJsonPath) => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return Object.entries(packageJson.scripts ?? {}).map(([scriptName, command]) => ({
      command,
      packageJsonPath,
      scriptName,
    }));
  });
}

export function workspaceManifestsByName() {
  const manifests = new Map();
  for (const packageJsonPath of findPackageJsonFiles(process.cwd())) {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@brainstrike/')) {
      manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

export function workspaceDependencyClosure(manifest, manifests) {
  const closure = new Set();
  const queue = [manifest];
  while (queue.length > 0) {
    const current = queue.pop();
    const declared = {
      ...current.dependencies,
      ...current.devDependencies,
      ...current.optionalDependencies,
    };
    for (const name of Object.keys(declared)) {
      if (manifests.has(name) && !closure.has(name)) {
        closure.add(name);
        queue.push(manifests.get(name));
      }
    }
  }
  return closure;
}

export function parseFilterList(command) {
  return [...command.matchAll(/--filter=(@brainstrike\/[\w-]+)/gu)].map(([, name]) => name);
}

export function findPackageJsonFiles(root) {
  return findRepoFiles(root, (entry) => entry.name === 'package.json');
}

export function findModuleFiles(root) {
  return findRepoFiles(
    root,
    (entry, dir) => entry.name.endsWith('.mjs') && !dir.endsWith('__tests__')
  );
}

function findRepoFiles(root, matches) {
  const matchedFiles = [];

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (matches(entry, dir)) {
          matchedFiles.push(join(dir, entry.name));
        }
        continue;
      }

      if (REPO_ROOT_IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const child = join(dir, entry.name);
      // Agent tooling parks whole checkouts in the tree (`.muse/worktrees`
      // reached this sweep even though `.claude` was listed). A foreign
      // checkout's scripts are not this repository's to assert on.
      if (isForeignCheckout(child)) {
        continue;
      }
      if (statSync(child).isDirectory()) {
        visit(child);
      }
    }
  }

  visit(root);
  return matchedFiles;
}
