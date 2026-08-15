import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  TERMINAL_APP_ID,
  type WorkspaceApp,
} from '@brainstrike/file-explorer-ui/shell';
import { Files, GitCompare, PanelsTopLeft, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The workspace app registry (BST-1258, Terminal added in BST-1270).
 * Canonical display order: Files, Changes, Canvas, Terminal. Optional
 * surfaces register only when their content exists — capability gating by
 * omission, never a stub (web passes none of the optional contents).
 */
export function buildWorkspaceApps(args: {
  readonly canvasPanelContent?: ReactNode;
  readonly changesPageContent?: ReactNode;
  readonly filesContent: ReactNode;
  readonly terminalPageContent?: ReactNode;
}): readonly WorkspaceApp[] {
  const { canvasPanelContent, changesPageContent, filesContent, terminalPageContent } = args;
  const apps: WorkspaceApp[] = [
    {
      icon: Files,
      id: CONTEXT_EXPLORER_APP_ID,
      label: 'Files',
      render: () => filesContent,
    },
  ];
  if (changesPageContent) {
    apps.push({
      icon: GitCompare,
      id: CHANGES_APP_ID,
      label: 'Changes',
      render: () => changesPageContent,
    });
  }
  if (canvasPanelContent) {
    apps.push({
      icon: PanelsTopLeft,
      id: CANVAS_APP_ID,
      label: 'Canvas',
      render: () => canvasPanelContent,
    });
  }
  if (terminalPageContent) {
    apps.push({
      icon: SquareTerminal,
      id: TERMINAL_APP_ID,
      label: 'Terminal',
      render: () => terminalPageContent,
    });
  }
  return apps;
}
