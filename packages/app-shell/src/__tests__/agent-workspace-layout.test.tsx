import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWorkspaceLayout } from '../agent-workspace-layout';

const ideLayoutProps: unknown[] = [];

vi.mock('@brainstrike/ui', () => ({
  IdeLayout: (props: {
    children: ReactNode;
    leftPanelContent?: ReactNode;
    rightPanelContent?: ReactNode;
  }) => {
    ideLayoutProps.push(props);
    return (
      <div>
        {props.leftPanelContent}
        {props.children}
        {props.rightPanelContent}
      </div>
    );
  },
}));

describe('AgentWorkspaceLayout', () => {
  beforeEach(() => {
    ideLayoutProps.length = 0;
  });

  it('gives the Library enough room for database inspection while preserving adjacent panes', () => {
    render(
      <AgentWorkspaceLayout
        assistantContent={<div>Assistant</div>}
        sidebarContent={<div>Library</div>}
        workspaceContent={<div>Workspace</div>}
      />
    );

    const props = ideLayoutProps.at(-1) as {
      leftPanelChrome: {
        hideButtonLabel: string;
        showButtonLabel: string;
        title: string;
      };
      panelConstraints: {
        leftPanelMaxSize: string;
        leftPanelMinSize: string;
        mainContentMinSize: string;
        rightPanelMaxSize: string;
        rightPanelMinSize: string;
      };
    };

    expect(props.leftPanelChrome).toMatchObject({
      hideButtonLabel: 'Hide library panel',
      showButtonLabel: 'Show library panel',
      title: 'Library',
    });
    expect(props.panelConstraints).toEqual({
      leftPanelMaxSize: '70%',
      leftPanelMinSize: '180px',
      mainContentMinSize: '15%',
      rightPanelMaxSize: '75%',
      rightPanelMinSize: '15%',
    });
  });
});
