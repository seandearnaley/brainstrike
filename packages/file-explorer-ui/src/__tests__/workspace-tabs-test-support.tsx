import type { ActionRegistry } from '@brainstrike/context-actions';
import { type RenderResult, render } from '@testing-library/react';
import { GitCompare, LayoutGrid, MessageSquare, PanelsTopLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { ContextExplorerAppBody } from '../shell/context-explorer-app-body';
import type { WorkspaceApp } from '../shell/workspace-app';
import { WorkspaceBody } from '../shell/workspace-body';
import { WorkspaceTabStrip } from '../shell/workspace-tab-strip';
import { WorkspaceOpenFileBridge, WorkspaceTabsProvider } from '../shell/workspace-tabs-context';
import { stubMatchMedia } from './setup/stub-match-media';
import { FileExplorerTestWrapper } from './test-helpers';

export const FILES_APP: WorkspaceApp = {
  icon: LayoutGrid,
  id: 'context-explorer',
  label: 'Files',
  placement: 'pinned',
  render: () => <ContextExplorerAppBody />,
};

export const CHANGES_APP: WorkspaceApp = {
  icon: GitCompare,
  id: 'changes',
  label: 'Changes',
  placement: 'pinned',
  render: () => <div data-testid="changes-app-body">Changes body</div>,
};

export const CANVAS_APP: WorkspaceApp = {
  icon: PanelsTopLeft,
  id: 'canvas',
  label: 'Canvas',
  placement: 'pinned',
  render: () => <div data-testid="canvas-app-body">Canvas body</div>,
};

export const DEMO_APP: WorkspaceApp = {
  icon: LayoutGrid,
  id: 'demo-app',
  label: 'Demo App',
  placement: 'pinned',
  render: () => <div data-testid="demo-app-body">Demo body</div>,
};

/** Child conversations scroll ahead of the file tabs (`placement: 'dynamic'`). */
export const CHILD_CEDAR_APP: WorkspaceApp = {
  icon: MessageSquare,
  id: 'delegated-conversation:cedar',
  label: 'Cedar',
  placement: 'dynamic',
  render: () => <div data-testid="cedar-app-body">Cedar body</div>,
};

export const CHILD_FLINT_APP: WorkspaceApp = {
  icon: MessageSquare,
  id: 'delegated-conversation:flint',
  label: 'Flint',
  placement: 'dynamic',
  render: () => <div data-testid="flint-app-body">Flint body</div>,
};

export interface WorkspaceHarnessOptions {
  /** Registry whose global actions join the strip menus (default: none). */
  readonly actionRegistry?: ActionRegistry;
}

export function WorkspaceHarness({
  actionRegistry,
  apps,
}: WorkspaceHarnessOptions & { readonly apps: readonly WorkspaceApp[] }): ReactNode {
  return (
    <FileExplorerTestWrapper {...(actionRegistry ? { actionRegistry } : {})}>
      <WorkspaceTabsProvider apps={apps}>
        <div data-testid="header-slot">
          <WorkspaceTabStrip />
        </div>
        <WorkspaceOpenFileBridge />
        <div data-testid="body-slot">
          <WorkspaceBody />
        </div>
      </WorkspaceTabsProvider>
    </FileExplorerTestWrapper>
  );
}

export function renderWorkspace(
  apps: readonly WorkspaceApp[] = [FILES_APP],
  options: WorkspaceHarnessOptions = {}
): RenderResult {
  // File tabs mount a resizable Group by default now that the explorer pane
  // is open-by-default (BST-1318) — it probes matchMedia while mounting.
  stubMatchMedia();
  return render(<WorkspaceHarness apps={apps} {...options} />);
}
