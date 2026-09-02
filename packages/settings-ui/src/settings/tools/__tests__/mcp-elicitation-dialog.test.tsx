import '@testing-library/jest-dom/vitest';
import {
  type McpElicitationPresentationWire,
  type McpElicitationSettlement,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { McpElicitationDialog } from '../mcp-elicitation-dialog';

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const provenance: McpElicitationPresentationWire['provenance'] = {
  configuredProtocol: '2026-07-28',
  configuredServerId: SERVER_ID,
  generation: 7,
  invocationId: 'nonce:1',
  negotiatedRevision: '2026-07-28',
  operation: { target: 'search_issues', type: 'tools/call' },
  requestId: 'elicitation-1',
  serverIdentity: {
    name: 'Linear MCP',
    title: 'Linear',
    version: '2.0.0',
    websiteOrigin: 'https://linear.example',
  },
  transport: 'streamable-http',
};
const formPresentation: McpElicitationPresentationWire = {
  id: 'presentation-1',
  message: 'Choose a workspace',
  mode: 'form',
  provenance,
  requestedSchema: {
    properties: {
      confirm: { description: 'Required to continue', title: 'Confirm', type: 'boolean' },
      count: { maximum: 10, minimum: 1, title: 'Count', type: 'integer' },
      labels: {
        items: { enum: ['bug', 'chore'], type: 'string' },
        title: 'Labels',
        type: 'array',
      },
      priority: {
        oneOf: [
          { const: 'p0', title: 'Urgent' },
          { const: 'p1', title: 'High' },
        ],
        title: 'Priority',
        type: 'string',
      },
      workspace: { minLength: 2, title: 'Workspace', type: 'string' },
    },
    required: ['workspace'],
    type: 'object',
  },
};
const urlPresentation: McpElicitationPresentationWire = {
  id: 'presentation-2',
  message: 'Finish authorization in your browser',
  mode: 'url',
  provenance,
  url: 'https://linear.example/authorize?flow=abc123&return=https://app.example/done',
};
const expectedBase = {
  configuredServerId: SERVER_ID,
  generation: 7,
  id: 'presentation-1',
  requestId: 'elicitation-1',
} as const;

function renderDialog(
  presentation: McpElicitationPresentationWire,
  overrides: Partial<Parameters<typeof McpElicitationDialog>[0]> = {}
) {
  const onSettle = vi.fn(async (_settlement: McpElicitationSettlement) => undefined);
  const onDismissRetired = vi.fn();
  const view = render(
    <McpElicitationDialog
      onDismissRetired={onDismissRetired}
      onSettle={onSettle}
      presentation={presentation}
      {...overrides}
    />
  );
  return { onDismissRetired, onSettle, view };
}

beforeAll(() => {
  // Radix Select observes its trigger size; jsdom has no ResizeObserver.
  if (typeof global.ResizeObserver === 'undefined') {
    class ResizeObserver {
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    global.ResizeObserver = ResizeObserver as unknown as typeof global.ResizeObserver;
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('McpElicitationDialog', () => {
  it('renders provenance in the accessible title/description and names every schema field', async () => {
    renderDialog(formPresentation);
    const dialog = await screen.findByRole('dialog', { name: 'Linear is requesting input' });
    expect(dialog).toHaveAccessibleDescription(
      'Configured server "team.linear.prod" — Linear MCP 2.0.0 (https://linear.example) — asked during tools/call search_issues over streamable-http, MCP revision 2026-07-28.'
    );
    expect(dialog).toHaveAttribute('data-testid', 'mcp-elicitation-dialog');
    expect(within(dialog).getByTestId('mcp-elicitation-form-presentation-1')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose a workspace')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();

    expect(within(dialog).getByRole('checkbox', { name: 'Confirm' })).toHaveAccessibleDescription(
      'Required to continue'
    );
    expect(within(dialog).getByRole('spinbutton', { name: 'Count' })).toHaveAttribute('max', '10');
    expect(within(dialog).getByRole('group', { name: 'Labels' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'bug' })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'chore' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Priority' })).toBeInTheDocument();
    const workspace = within(dialog).getByRole('textbox', { name: 'Workspace' });
    expect(workspace).toHaveAttribute('aria-required', 'true');
    expect(
      within(dialog).getByRole('button', { name: 'Decline MCP request from Linear' })
    ).toHaveFocus();
  });

  it('blocks accept until required fields validate, then posts exactly the settlement shape', async () => {
    const user = userEvent.setup();
    const { onSettle } = renderDialog(formPresentation);
    const dialog = await screen.findByRole('dialog');
    const accept = within(dialog).getByRole('button', {
      name: 'Accept and send input to Linear',
    });

    await user.click(accept);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('workspace: This field is required.');
    expect(within(dialog).getByRole('textbox', { name: 'Workspace' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(onSettle).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole('textbox', { name: 'Workspace' }), 'E');
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Count' }), '11');
    await user.click(accept);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'workspace: Enter at least 2 characters.'
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'count: Enter a value of at most 10.'
    );
    expect(onSettle).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole('textbox', { name: 'Workspace' }), 'ngineering');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Count' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Count' }), '3');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Confirm' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'chore' }));
    await user.click(accept);
    await waitFor(() => expect(onSettle).toHaveBeenCalledOnce());
    expect(onSettle.mock.calls[0]?.[0]).toEqual({
      ...expectedBase,
      action: 'accept',
      content: { confirm: true, count: 3, labels: ['chore'], workspace: 'Engineering' },
    });
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(accept).toBeDisabled();
  });

  it('posts decline and cancel without content and surfaces settlement failures', async () => {
    const user = userEvent.setup();
    const { onSettle } = renderDialog(formPresentation);
    const dialog = await screen.findByRole('dialog');
    onSettle.mockRejectedValueOnce(
      new Error('MCP elicitation settlement failed: mcp-elicitation-stale-authority')
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Decline MCP request from Linear' })
    );
    expect(onSettle).toHaveBeenLastCalledWith({ ...expectedBase, action: 'decline' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'mcp-elicitation-stale-authority'
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Cancel MCP request from Linear' })
    );
    expect(onSettle).toHaveBeenLastCalledWith({ ...expectedBase, action: 'cancel' });
    for (const call of onSettle.mock.calls) {
      expect(call[0]).not.toHaveProperty('content');
    }
  });

  it('shows the full URL verbatim, never opens it, and declines without opening', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { onSettle } = renderDialog(urlPresentation);
    const dialog = await screen.findByRole('dialog', { name: 'Linear wants to open a link' });
    expect(within(dialog).getByTestId('mcp-elicitation-url-presentation-2')).toBeInTheDocument();
    expect(within(dialog).getByTestId('mcp-elicitation-url')).toHaveTextContent(
      urlPresentation.url
    );
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      'Accepting opens this exact address in your external browser.'
    );

    await user.click(
      within(dialog).getByRole('button', { name: 'Decline MCP request from Linear' })
    );
    expect(onSettle).toHaveBeenCalledWith({
      ...expectedBase,
      action: 'decline',
      id: 'presentation-2',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('replaces the actions with a retirement notice once the request is retired', async () => {
    const user = userEvent.setup();
    const { onDismissRetired, onSettle } = renderDialog(formPresentation, {
      retiredCode: 'mcp-elicitation-stale-authority',
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'This request is no longer pending (mcp-elicitation-stale-authority).'
    );
    expect(within(dialog).queryByRole('button', { name: /Accept/u })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Decline/u })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Cancel/u })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Workspace' })).toBeDisabled();
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Dismiss retired MCP request from Linear' })
      ).toHaveFocus()
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Dismiss retired MCP request from Linear' })
    );
    expect(onDismissRetired).toHaveBeenCalledOnce();
    expect(onSettle).not.toHaveBeenCalled();
  });
});
