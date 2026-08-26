/**
 * Workspace app registry construction (BST-1270): capability gating by
 * omission — an absent content prop yields NO entry (never a stub), and
 * Terminal registers as a closable workspace app when the desktop passes its
 * surface.
 */

import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  TERMINAL_APP_ID,
  WORKTREE_MAP_APP_ID,
} from '@brainstrike/file-explorer-ui/shell';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceApps } from '../build-workspace-apps';

describe('buildWorkspaceApps', () => {
  it('web shape: Files only when no optional contents exist', () => {
    const apps = buildWorkspaceApps({ filesContent: 'files' });
    expect(apps.map((app) => app.id)).toEqual([CONTEXT_EXPLORER_APP_ID]);
  });

  it('desktop shape: canonical order Files, Changes, Canvas, Terminal', () => {
    const apps = buildWorkspaceApps({
      canvasPanelContent: 'canvas',
      changesPageContent: 'changes',
      filesContent: 'files',
      terminalPageContent: 'terminal',
    });
    expect(apps.map((app) => app.id)).toEqual([
      CONTEXT_EXPLORER_APP_ID,
      CHANGES_APP_ID,
      CANVAS_APP_ID,
      TERMINAL_APP_ID,
    ]);
    expect(apps.at(-1)?.label).toBe('Terminal');
    expect(apps.at(-1)?.render()).toBe('terminal');
  });

  it('places the Worktree Map after Changes and before Canvas when EVERY app is registered', () => {
    // All four optional contents present, deliberately: an ordering assertion
    // with only two of them cannot tell "after Changes" from "appended last",
    // which is exactly the mistake a new push() at the end of the builder makes.
    const apps = buildWorkspaceApps({
      canvasPanelContent: <div>canvas</div>,
      changesPageContent: <div>changes</div>,
      filesContent: <div>files</div>,
      terminalPageContent: <div>terminal</div>,
      worktreeMapPageContent: <div>map</div>,
    });

    expect(apps.map((app) => app.id)).toEqual([
      CONTEXT_EXPLORER_APP_ID,
      CHANGES_APP_ID,
      WORKTREE_MAP_APP_ID,
      CANVAS_APP_ID,
      TERMINAL_APP_ID,
    ]);
    expect(apps.find((app) => app.id === WORKTREE_MAP_APP_ID)?.label).toBe('Worktrees');
  });

  it('registers the Worktree Map even when Changes is absent', () => {
    // Independence: the Map's registration must not be nested under, or
    // ordered relative to, a sibling that happens to be missing.
    const apps = buildWorkspaceApps({
      filesContent: <div>files</div>,
      worktreeMapPageContent: <div>map</div>,
    });

    expect(apps.map((app) => app.id)).toEqual([CONTEXT_EXPLORER_APP_ID, WORKTREE_MAP_APP_ID]);
  });

  it('omits the Worktree Map entirely when no content is supplied (web)', () => {
    const apps = buildWorkspaceApps({ filesContent: <div>files</div> });

    expect(apps.map((app) => app.id)).toEqual([CONTEXT_EXPLORER_APP_ID]);
  });
});
