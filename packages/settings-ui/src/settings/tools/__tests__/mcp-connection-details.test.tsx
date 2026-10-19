import '@testing-library/jest-dom/vitest';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerStatusRow } from '../mcp-server-status-row';
import type { McpServerInfo } from '../types';

const connected = {
  auth: {
    credentialState: 'stored',
    grantedScopes: ['read'],
    requestedScopes: ['read'],
    resourceUrl: 'https://linear.example/mcp',
    type: 'oauth-user',
  },
  configuredProtocol: 'auto',
  configuredServerId: parseConfiguredMcpServerId('linear'),
  diagnostics: [{ message: 'Handshake complete', stream: 'stderr', truncated: false }],
  extensions: { apps: true, tasks: false },
  generation: 4,
  negotiated: { era: 'modern', revision: '2026-07-28' },
  state: 'connected',
  transport: 'streamable-http',
} satisfies McpServerInfo;

afterEach(cleanup);

describe('MCP connection details disclosure', () => {
  it('keeps actions visible and reveals connection facts locally on demand', () => {
    const onControl = vi.fn();
    render(<McpServerStatusRow controlAvailable onControl={onControl} server={connected} />);

    expect(screen.getByRole('button', { name: 'Disconnect linear' })).toBeVisible();
    expect(screen.getByText('connected', { exact: true })).toBeVisible();
    const summary = screen.getByLabelText('Connection details for linear');
    const details = summary.closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('OAuth credentials stored')).not.toBeVisible();
    expect(screen.getByTestId('mcp-diagnostics-linear')).not.toBeVisible();

    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('OAuth credentials stored')).toBeVisible();
    expect(screen.getByTestId('mcp-extensions-linear')).toBeVisible();
    expect(screen.getByTestId('mcp-diagnostics-linear')).toBeVisible();
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute('open');
    expect(onControl).not.toHaveBeenCalled();
  });

  it('never hides a server failure or its recovery controls inside details', () => {
    render(
      <McpServerStatusRow
        controlAvailable
        onControl={vi.fn()}
        server={{
          ...connected,
          error: {
            category: 'connection',
            code: 'mcp-transport-failed',
            message: 'Connection lost',
          },
          state: 'error',
        }}
      />
    );
    expect(screen.getByText(/Connection lost/u)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry linear' })).toBeVisible();
    expect(screen.getByTestId('mcp-diagnostics-linear')).toBeVisible();
  });

  it.each([
    { auth: { credentialState: 'malformed', type: 'bearer' }, control: 'Connect' },
    { auth: { ...connected.auth, credentialState: 'unreadable' }, control: 'Disconnect' },
  ] as const)(
    'keeps $auth.credentialState credential failures visible before opening details',
    ({ auth, control }) => {
      render(
        <McpServerStatusRow
          controlAvailable
          onControl={vi.fn()}
          server={{
            ...connected,
            auth,
            state: 'authentication-required',
          }}
        />
      );
      expect(screen.getByRole('status')).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent(
        `Stored credentials are ${auth.credentialState}`
      );
      expect(screen.getByRole('button', { name: `${control} linear` })).toBeVisible();
    }
  );
  it('retains the live region while credential fault content changes', () => {
    const { rerender } = render(
      <McpServerStatusRow controlAvailable onControl={vi.fn()} server={connected} />
    );
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    rerender(
      <McpServerStatusRow
        controlAvailable
        onControl={vi.fn()}
        server={{
          ...connected,
          auth: { ...connected.auth, credentialState: 'unreadable' },
          state: 'authentication-required',
        }}
      />
    );
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Stored credentials are unreadable');
    rerender(<McpServerStatusRow controlAvailable onControl={vi.fn()} server={connected} />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });

  it('preserves expansion within a generation and resets it for the next generation', () => {
    const onControl = vi.fn();
    const { rerender } = render(
      <McpServerStatusRow controlAvailable onControl={onControl} server={connected} />
    );
    fireEvent.click(screen.getByLabelText('Connection details for linear'));
    rerender(
      <McpServerStatusRow
        controlAvailable
        onControl={onControl}
        server={{ ...connected, diagnostics: [] }}
      />
    );
    expect(
      screen.getByLabelText('Connection details for linear').closest('details')
    ).toHaveAttribute('open');
    rerender(
      <McpServerStatusRow
        controlAvailable
        onControl={onControl}
        server={{ ...connected, generation: 5 }}
      />
    );
    expect(
      screen.getByLabelText('Connection details for linear').closest('details')
    ).not.toHaveAttribute('open');
    expect(onControl).not.toHaveBeenCalled();
  });
});

describe('MCP tools availability notice (BST-1632)', () => {
  const features = {
    completion: false,
    promptListChanged: false,
    prompts: false,
    resourceListChanged: false,
    resourceSubscriptions: false,
    resources: false,
    toolListChanged: true,
    tools: true,
  };
  const base = {
    errors: {},
    features,
    subscription: { mode: 'none', state: 'unsupported' },
  } as const;

  it.each([
    ['loading', { ...base, listing: ['tools'] as const }, 'connected · loading tools'],
    ['empty', { ...base, tools: { tools: [] } }, 'connected · no tools'],
    [
      'unsupported',
      { ...base, features: { ...features, tools: false } },
      'connected · offers no tools',
    ],
  ] as const)('states %s plainly, never as a warning', (availability, catalog, text) => {
    render(
      <McpServerStatusRow controlAvailable onControl={vi.fn()} server={{ ...connected, catalog }} />
    );
    const notice = screen.getByText(text);
    expect(notice).toHaveAttribute('data-tools-availability', availability);
    expect(notice).toHaveClass('text-muted-foreground');
    expect(notice).not.toHaveClass('text-warning');
  });

  it('keeps a failed tool list amber', () => {
    render(
      <McpServerStatusRow
        controlAvailable
        onControl={vi.fn()}
        server={{
          ...connected,
          catalog: {
            ...base,
            errors: { tools: { category: 'protocol', code: 'boom', message: 'Connection closed' } },
          },
        }}
      />
    );
    const notice = screen.getByText(/tools unavailable/u);
    expect(notice).toHaveAttribute('data-tools-availability', 'tools-unavailable');
    expect(notice).toHaveClass('text-warning');
  });

  it('says nothing when the server listed tools', () => {
    render(
      <McpServerStatusRow
        controlAvailable
        onControl={vi.fn()}
        server={{
          ...connected,
          catalog: {
            ...base,
            tools: { tools: [{ inputSchema: { type: 'object' }, name: 'echo' }] },
          },
        }}
      />
    );
    expect(screen.queryByText(/connected ·/u)).not.toBeInTheDocument();
  });
});
