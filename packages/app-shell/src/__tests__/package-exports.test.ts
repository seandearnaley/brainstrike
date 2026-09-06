import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('@brainstrike/app-shell package contract', () => {
  it('publishes only the supported export subpaths', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(Object.keys(manifest.exports).sort()).toEqual(
      [
        '.',
        './browser-pane/availability',
        './browser-pane/browser-pane-content',
        './canvas/canvas-panel',
        './changes',
        './changes/availability',
        './connected-prompt-manager-lazy',
        './cost-tracking-settings',
        './diagnostics',
        './forge/availability',
        './git-panel',
        './git-panel/availability',
        './navigation',
        './notes-page-content',
        './platform-bridge',
        './root-layout-content',
        './roots/root-registry',
        './styles.css',
        './terminal-panel',
        './terminal-panel/availability',
        './types',
        './use-document-title',
        './user-commands-bridge',
        './worktree-map',
        './worktrees/availability',
        './workspace-connect/workspace-connect-bridge',
      ].sort()
    );
  });
});
