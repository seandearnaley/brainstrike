import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface PackageManifest {
  exports: Record<string, unknown>;
}

const readManifest = (): PackageManifest =>
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;

describe('@brainstrike/assistant-ui package contract', () => {
  it('publishes the required export subpaths', () => {
    const manifest = readManifest();

    expect(Object.keys(manifest.exports).sort()).toEqual(
      [
        '.',
        './context-usage-store',
        './follow-up-queue-store',
        './mcp-task-bridge-context',
        './mcp-task-status-card',
        './rewind-composer-store',
        './tool-fallback',
        './tool-result-renderer-context',
        './tool-result-renderers',
        './worktree-archive-confirmation-dialog',
        // Tailwind source directive, imported by both app stylesheets.
        './styles.css',
      ].sort()
    );
  });

  it('has a source root entry point', () => {
    expect(existsSync(join(packageRoot, 'src/index.ts'))).toBe(true);
  });

  it('maps every compiled module export to a source module', () => {
    const manifest = readManifest();

    for (const [exportName, target] of Object.entries(manifest.exports)) {
      if (typeof target !== 'object' || target === null) {
        continue;
      }

      const conditions = target as Record<string, unknown>;
      const importTarget = conditions['import'];
      const typesTarget = conditions['types'];

      expect(importTarget, `${exportName} import target`).toBeTypeOf('string');
      expect(typesTarget, `${exportName} types target`).toBeTypeOf('string');

      if (typeof importTarget !== 'string' || typeof typesTarget !== 'string') {
        continue;
      }

      const importStem = importTarget.replace(/^\.\/dist\//, '').replace(/\.js$/, '');
      const typesStem = typesTarget.replace(/^\.\/dist\//, '').replace(/\.d\.ts$/, '');

      expect(importStem, `${exportName} import/types targets`).toBe(typesStem);
      expect(
        ['.ts', '.tsx'].some((extension) =>
          existsSync(join(packageRoot, 'src', `${importStem}${extension}`))
        ),
        `${exportName} source for ${importTarget}`
      ).toBe(true);
    }
  });

  it('keeps the archive dialog off the root barrel', () => {
    const rootSource = readFileSync(join(packageRoot, 'src/index.ts'), 'utf8');

    expect(rootSource).not.toContain('WorktreeArchiveConfirmationDialog');
    expect(rootSource).not.toContain('WorktreeArchiveConfirmation');
  });
});
