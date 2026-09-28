import { type RenderResult, render } from '@testing-library/react';
import { GitCompare, LayoutGrid, PanelsTopLeft } from 'lucide-react';
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

export function WorkspaceHarness({ apps }: { readonly apps: readonly WorkspaceApp[] }): ReactNode {
  return (
    <FileExplorerTestWrapper>
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

export function renderWorkspace(apps: readonly WorkspaceApp[] = [FILES_APP]): RenderResult {
  // File tabs mount a resizable Group by default now that the explorer pane
  // is open-by-default (BST-1318) — it probes matchMedia while mounting.
  stubMatchMedia();
  return render(<WorkspaceHarness apps={apps} />);
}
