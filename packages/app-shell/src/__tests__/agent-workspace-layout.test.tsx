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

  it('gives the Threads panel enough room while preserving adjacent panes', () => {
    render(
      <AgentWorkspaceLayout
        assistantContent={<div>Assistant</div>}
        sidebarContent={<div>Threads</div>}
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
      hideButtonLabel: 'Hide threads panel',
      showButtonLabel: 'Show threads panel',
      title: 'Threads',
    });
    expect(props.panelConstraints).toEqual({
      leftPanelMaxSize: '70%',
      leftPanelMinSize: '180px',
      mainContentMinSize: '360px',
      rightPanelMaxSize: '75%',
      rightPanelMinSize: '192px',
    });
  });

  it('threads workspaceHeaderContent into the right panel chrome as headerContent', () => {
    render(
      <AgentWorkspaceLayout
        assistantContent={<div>Assistant</div>}
        sidebarContent={<div>Threads</div>}
        workspaceContent={<div>Workspace</div>}
        workspaceHeaderContent={<div data-testid="strip">Strip</div>}
      />
    );

    const props = ideLayoutProps.at(-1) as {
      rightPanelChrome: { headerContent?: ReactNode; title: string };
    };
    expect(props.rightPanelChrome.title).toBe('Workspace');
    expect(props.rightPanelChrome.headerContent).toBeTruthy();
  });

  it('omits headerContent from the right panel chrome when no strip is provided', () => {
    render(
      <AgentWorkspaceLayout
        assistantContent={<div>Assistant</div>}
        sidebarContent={<div>Threads</div>}
        workspaceContent={<div>Workspace</div>}
      />
    );

    const props = ideLayoutProps.at(-1) as {
      rightPanelChrome: { headerContent?: ReactNode };
    };
    expect(props.rightPanelChrome.headerContent).toBeUndefined();
  });
});
