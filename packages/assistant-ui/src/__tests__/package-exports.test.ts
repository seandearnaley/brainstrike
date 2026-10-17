// @vitest-environment node
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

type RootExportNames = keyof typeof import('../index');
type ForbiddenArchiveRootExport = Extract<RootExportNames, 'WorktreeArchiveConfirmationDialog'>;

// This value-export invariant is enforced by the test TypeScript program, not by Vitest at runtime.
const rootHasNoForbiddenArchiveExports: ForbiddenArchiveRootExport extends never ? true : never =
  true;

// @ts-expect-error -- the archive confirmation type must not be re-exported from the root barrel.
export type ForbiddenArchiveRootType = import('../index').WorktreeArchiveConfirmation;

describe('@brainstrike/assistant-ui package contract', () => {
  it('publishes the required export subpaths', () => {
    const manifest = readManifest();

    expect(Object.keys(manifest.exports).sort()).toEqual(
      [
        '.',
        // The pure activity-row model (`deriveActivitySteps`), for the desktop
        // conversation-shape helper (apps/desktop/src/__tests__/helpers/
        // conversation-shape.ts): a leaf module with no lazy panel graph.
        './activity-trace-model',
        // Two leaf modules, imported INSTEAD of the root barrel so a host can
        // provide or read the link seam without dragging the lazy panel graph
        // (assistant-ui-panel, Streamdown, Shiki) into the eager chunk.
        // They stay split because a file exporting both a component and a hook
        // trips react-refresh/only-export-components.
        './assistant-link-capabilities',
        './assistant-link-capabilities-provider',
        './context-usage-store',
        './data-stream-runtime',
        './follow-up-queue-store',
        './mcp-task-bridge-context',
        './mcp-task-status-card',
        './rewind-composer-store',
        // The thread context map's fold and its per-thread store (ADR-0021):
        // leaf modules, so the Context tab and factory reset skip the barrel.
        './thread-context-fold',
        './thread-context-store',
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

      expect(importTarget, `${exportName} import target`).toMatch(/^\.\/dist\/.+\.js$/);
      expect(typesTarget, `${exportName} types target`).toMatch(/^\.\/dist\/.+\.d\.ts$/);

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

    expect(rootHasNoForbiddenArchiveExports).toBe(true);
    expect(rootSource).not.toContain('worktree-archive-confirmation-dialog');
  });
});
