import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sweepIgnoredDirectories = new Set(['.claude', '.git', '.turbo', 'dist', 'node_modules']);

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

      if (sweepIgnoredDirectories.has(entry.name)) {
        continue;
      }

      const child = join(dir, entry.name);
      if (statSync(child).isDirectory()) {
        visit(child);
      }
    }
  }

  visit(root);
  return matchedFiles;
}
