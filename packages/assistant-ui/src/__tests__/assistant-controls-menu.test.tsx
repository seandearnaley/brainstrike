import type { AssistantProviderSettingsMap } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ControlsMenu } from '../assistant-controls-menu';
import type { AssistantToolMenuConfig } from '../assistant-ui-panel';

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  const Shell = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  const Content = ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>;
  const Trigger = ({ children }: { children: ReactNode }) => <>{children}</>;

  return {
    ...actual,
    Popover: Shell,
    PopoverContent: Content,
    PopoverTrigger: Trigger,
  };
});

vi.mock('../provider-settings-panel', () => ({
  ProviderSettingsPanel: ({
    modelName,
    providerId,
  }: {
    modelName?: string;
    providerId?: string;
  }) => (
    <div data-model-name={modelName ?? ''} data-provider-id={providerId ?? ''}>
      Provider settings panel
    </div>
  ),
}));

describe('ControlsMenu', () => {
  it('always renders the trigger and the Detail control, even without tools or reasoning', () => {
    // The Detail control is always relevant, so the menu no longer hides itself.
    render(<ControlsMenu />);

    expect(screen.getByRole('button', { name: 'Open assistant controls' })).toBeInTheDocument();
    expect(screen.getByText('Detail')).toBeInTheDocument();
  });

  it('renders output & limits controls for supported providers', () => {
    const settings = {
      OpenAI: {
        reasoningEffort: 'low',
      },
    } satisfies AssistantProviderSettingsMap;

    render(
      <ControlsMenu
        modelName="gpt-5"
        onProviderSettingsChange={vi.fn()}
        providerSettings={settings}
        selectedProvider="OpenAI"
      />
    );

    expect(screen.getByRole('button', { name: 'Open assistant controls' })).toBeInTheDocument();
    expect(screen.getByText('Output & Limits')).toBeInTheDocument();
    expect(screen.getByText('Provider settings panel')).toHaveAttribute(
      'data-provider-id',
      'OpenAI'
    );
    expect(screen.getByText('Provider settings panel')).toHaveAttribute('data-model-name', 'gpt-5');
  });

  it('hides reasoning settings for unsupported providers but still shows the menu', () => {
    render(<ControlsMenu onProviderSettingsChange={vi.fn()} selectedProvider="local" />);

    expect(screen.getByRole('button', { name: 'Open assistant controls' })).toBeInTheDocument();
    expect(screen.queryByText('Output & Limits')).not.toBeInTheDocument();
  });

  it('groups tools by source and label, summarizes enabled counts, and routes actions', async () => {
    const user = userEvent.setup();
    const onToggleTool = vi.fn();
    const onRefresh = vi.fn();
    const onOpenSettings = vi.fn();
    const toolMenu = {
      items: [
        {
          enabled: false,
          group: 'Zeta',
          id: 'mcp-search',
          label: 'MCP Search',
          source: 'mcp',
        },
        {
          description: 'Reads local context',
          enabled: true,
          group: 'Alpha',
          id: 'native-read',
          label: 'Native Read',
          source: 'native',
        },
        {
          enabled: false,
          group: 'Beta',
          id: 'native-write',
          label: 'Native Write',
          source: 'native',
        },
      ],
      onOpenSettings,
      onRefresh,
      onToggleTool,
    } satisfies AssistantToolMenuConfig;

    render(<ControlsMenu toolMenu={toolMenu} />);

    expect(screen.getByText('AI Tools')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 enabled')).toBeInTheDocument();
    expect(screen.getByText('Native Read')).toBeInTheDocument();
    expect(screen.queryByText('Reads local context')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Native Read' })).toBeInTheDocument();

    const groupLabels = screen
      .getAllByText(/Alpha|Beta|Zeta/)
      .map((element) => element.textContent ?? '');
    expect(groupLabels).toEqual(['Alpha', 'Beta', 'Zeta']);
    expect(screen.getByText('1/1')).toBeInTheDocument();
    expect(screen.getAllByText('0/1')).toHaveLength(2);

    const nativeWriteSwitch = screen.getByRole('switch', { name: 'Native Write enabled' });
    if (!nativeWriteSwitch) {
      throw new Error('Expected the native write tool switch to render');
    }
    await user.click(nativeWriteSwitch);
    expect(onToggleTool).toHaveBeenCalledWith('native-write', true);

    await user.click(screen.getByRole('button', { name: 'Refresh tools' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /Manage tools/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('filters tools by name, id, group and description while retaining enabled counts', async () => {
    const user = userEvent.setup();
    render(
      <ControlsMenu
        toolMenu={{
          items: [
            {
              description: 'Reads current workspace',
              enabled: true,
              group: 'Native Tools',
              id: 'native-read',
              label: 'Read File',
              source: 'native',
            },
            {
              enabled: false,
              group: 'Native Tools',
              id: 'native-write',
              label: 'Write File',
              source: 'native',
            },
            {
              enabled: true,
              group: 'linear',
              id: 'mcp-issue',
              label: 'Create Issue',
              source: 'mcp',
            },
          ],
        }}
      />
    );

    const search = screen.getByRole('searchbox', { name: 'Search tools' });
    await user.click(screen.getByText('Native Tools', { selector: 'summary span' }));
    expect(
      screen.getByText('Native Tools', { selector: 'summary span' }).closest('details')
    ).toHaveAttribute('open');
    await user.type(search, 'workspace');
    expect(screen.getByText('Read File')).toBeInTheDocument();
    expect(screen.queryByText('Write File')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Issue')).not.toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();

    await user.clear(search);
    expect(
      screen.getByText('Native Tools', { selector: 'summary span' }).closest('details')
    ).toHaveAttribute('open');
    await user.type(search, 'mcp-issue');
    expect(screen.getByText('Create Issue')).toBeInTheDocument();
    expect(screen.queryByText('Read File')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'linear');
    expect(screen.getByText('Create Issue')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'unmatched');
    expect(screen.getByText(/No tools match/)).toBeInTheDocument();
  });

  it('uses a supplied tool summary and disables tools without a toggle handler', () => {
    const toolMenu = {
      items: [
        {
          enabled: true,
          group: 'Native',
          id: 'native-read',
          label: 'Native Read',
          source: 'native',
        },
      ],
      summary: 'Custom tool summary',
    } satisfies AssistantToolMenuConfig;

    render(<ControlsMenu toolMenu={toolMenu} />);

    expect(screen.getByText('Custom tool summary')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('Native Read')).toBeInTheDocument();
  });

  it('shows the loading state while tool discovery is in progress', () => {
    const toolMenu = {
      isLoading: true,
      items: [
        {
          enabled: true,
          group: 'Native',
          id: 'native-read',
          label: 'Native Read',
          source: 'native',
        },
      ],
    } satisfies AssistantToolMenuConfig;

    render(<ControlsMenu toolMenu={toolMenu} />);

    expect(screen.getByText(/Loading tools/)).toBeInTheDocument();
    expect(screen.queryByText('Native Read')).not.toBeInTheDocument();
  });
});
