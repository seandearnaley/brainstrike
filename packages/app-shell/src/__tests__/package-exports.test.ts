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
        './app-reload',
        './assistant-thread-host-context',
        './browser-pane/availability',
        './browser-pane/browser-pane-content',
        './canvas/canvas-panel',
        './changes',
        './changes/availability',
        './changes/use-last-turn-follower',
        './connected-prompt-manager-lazy',
        './cost-tracking-settings',
        './diagnostics',
        './forge/availability',
        './git-panel',
        './git-panel/availability',
        './mcp-content-capability',
        './mcp-status-capability',
        './mcp-tools-capability',
        './navigation',
        './notes-page-content',
        './platform-bridge',
        './root-layout-content',
        './roots/root-identity-context',
        './roots/root-registry',
        './styles.css',
        './terminal-panel',
        './terminal-panel/availability',
        './types',
        './use-document-title',
        './use-workspace-search-controller',
        './user-commands-bridge',
        './worktree-map',
        './worktrees/availability',
        './workspace-connect/workspace-connect-bridge',
      ].sort()
    );
  });
});
