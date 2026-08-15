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
});
