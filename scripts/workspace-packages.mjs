import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export function readWorkspaceGlobs(root) {
  const globs = parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).packages;
  if (
    !Array.isArray(globs) ||
    globs.length === 0 ||
    globs.some((glob) => typeof glob !== 'string')
  ) {
    throw new Error('Workspace packages must be a nonempty list of glob strings');
  }
  if (globs.some((glob) => glob.startsWith('!'))) {
    throw new Error('Workspace exclusion globs need explicit discovery support');
  }
  return globs;
}

export function workspacePackages(root) {
  const packages = new Map();
  for (const group of readWorkspaceGlobs(root)) {
    const manifests = globSync(`${group}/package.json`, {
      cwd: root,
      exclude: ['**/node_modules/**', '**/dist/**'],
    });
    if (manifests.length === 0) {
      throw new Error(`Workspace group ${group} selected no packages`);
    }
    for (const file of manifests) {
      const dir = path.dirname(path.resolve(root, file));
      if (!existsSync(dir)) {
        throw new Error(`Workspace directory disappeared: ${dir}`);
      }
      const manifest = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
      packages.set(dir, {
        dir,
        group,
        manifest,
        name: manifest.name,
        relDir: path.relative(root, dir).replaceAll('\\', '/'),
        scripts: manifest.scripts ?? {},
      });
    }
  }
  return [...packages.values()].sort((a, b) => a.relDir.localeCompare(b.relDir));
}
