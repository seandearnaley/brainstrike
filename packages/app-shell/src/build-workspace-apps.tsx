import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  LOGS_APP_ID,
  TERMINAL_APP_ID,
  THREAD_CONTEXT_APP_ID,
  WORKTREE_MAP_APP_ID,
  type WorkspaceApp,
} from '@brainstrike/file-explorer-ui/shell';
import {
  Files,
  GitCompare,
  PanelsTopLeft,
  ScanSearch,
  ScrollText,
  SquareTerminal,
  Trees,
} from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The workspace app registry (BST-1258, Terminal added in BST-1270, Logs in BST-1791).
 * Canonical display order: Files, Changes, Context, Worktrees, Canvas, Terminal, Logs. Optional
 * surfaces register only when their content exists — capability gating by
 * omission, never a stub (web passes none of the optional contents).
 */
export function buildWorkspaceApps(args: {
  readonly canvasPanelContent?: ReactNode;
  readonly changesPageContent?: ReactNode;
  readonly filesContent: ReactNode;
  readonly logsPageContent?: ReactNode;
  readonly terminalPageContent?: ReactNode;
  readonly threadContextPageContent?: ReactNode;
  readonly worktreeMapPageContent?: ReactNode;
}): readonly WorkspaceApp[] {
  const {
    canvasPanelContent,
    changesPageContent,
    filesContent,
    logsPageContent,
    terminalPageContent,
    threadContextPageContent,
    worktreeMapPageContent,
  } = args;
  const apps: WorkspaceApp[] = [
    {
      icon: Files,
      id: CONTEXT_EXPLORER_APP_ID,
      label: 'Files',
      placement: 'pinned',
      render: () => filesContent,
    },
  ];
  if (changesPageContent) {
    apps.push({
      icon: GitCompare,
      id: CHANGES_APP_ID,
      label: 'Changes',
      placement: 'pinned',
      render: () => changesPageContent,
    });
  }
  if (threadContextPageContent) {
    // Reads beside writes: what the thread's model received (ADR-0021).
    apps.push({
      icon: ScanSearch,
      id: THREAD_CONTEXT_APP_ID,
      label: 'Context',
      placement: 'pinned',
      render: () => threadContextPageContent,
    });
  }
  if (worktreeMapPageContent) {
    apps.push({
      icon: Trees,
      id: WORKTREE_MAP_APP_ID,
      label: 'Worktrees',
      placement: 'pinned',
      render: () => worktreeMapPageContent,
    });
  }
  if (canvasPanelContent) {
    apps.push({
      icon: PanelsTopLeft,
      id: CANVAS_APP_ID,
      label: 'Canvas',
      placement: 'pinned',
      render: () => canvasPanelContent,
    });
  }
  if (terminalPageContent) {
    apps.push({
      icon: SquareTerminal,
      id: TERMINAL_APP_ID,
      label: 'Terminal',
      placement: 'pinned',
      render: () => terminalPageContent,
    });
  }
  if (logsPageContent) {
    apps.push({
      icon: ScrollText,
      id: LOGS_APP_ID,
      label: 'Logs',
      placement: 'pinned',
      render: () => logsPageContent,
    });
  }
  return apps;
}
