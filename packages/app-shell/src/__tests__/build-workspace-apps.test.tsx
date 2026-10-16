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
  LOGS_APP_ID,
  TERMINAL_APP_ID,
  THREAD_CONTEXT_APP_ID,
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

  it('pins every singleton app in the strip (BST-1839): none scrolls with the file tabs', () => {
    const apps = buildWorkspaceApps({
      canvasPanelContent: <div>canvas</div>,
      changesPageContent: <div>changes</div>,
      filesContent: <div>files</div>,
      terminalPageContent: <div>terminal</div>,
      worktreeMapPageContent: <div>map</div>,
    });

    expect(apps.map((app) => [app.id, app.placement])).toEqual([
      [CONTEXT_EXPLORER_APP_ID, 'pinned'],
      [CHANGES_APP_ID, 'pinned'],
      [WORKTREE_MAP_APP_ID, 'pinned'],
      [CANVAS_APP_ID, 'pinned'],
      [TERMINAL_APP_ID, 'pinned'],
    ]);
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

  it('registers the Context tab beside Changes only when its page exists', () => {
    const apps = buildWorkspaceApps({
      changesPageContent: 'changes',
      filesContent: 'files',
      threadContextPageContent: 'context',
      worktreeMapPageContent: 'worktrees',
    });
    expect(apps.map((app) => app.id)).toEqual([
      CONTEXT_EXPLORER_APP_ID,
      CHANGES_APP_ID,
      THREAD_CONTEXT_APP_ID,
      WORKTREE_MAP_APP_ID,
    ]);
    expect(apps[2]?.label).toBe('Context');
    expect(apps[2]?.render()).toBe('context');
    expect(
      buildWorkspaceApps({ filesContent: 'files' }).some((app) => app.id === THREAD_CONTEXT_APP_ID)
    ).toBe(false);
  });

  it('registers Logs last, after Terminal, only when its page exists (BST-1791)', () => {
    const apps = buildWorkspaceApps({
      filesContent: 'files',
      logsPageContent: 'logs',
      terminalPageContent: 'terminal',
    });
    expect(apps.map((app) => [app.id, app.placement])).toEqual([
      [CONTEXT_EXPLORER_APP_ID, 'pinned'],
      [TERMINAL_APP_ID, 'pinned'],
      [LOGS_APP_ID, 'pinned'],
    ]);
    expect(apps.at(-1)?.label).toBe('Logs');
    expect(apps.at(-1)?.render()).toBe('logs');
    expect(
      buildWorkspaceApps({ filesContent: 'files' }).some((app) => app.id === LOGS_APP_ID)
    ).toBe(false);
  });
});
