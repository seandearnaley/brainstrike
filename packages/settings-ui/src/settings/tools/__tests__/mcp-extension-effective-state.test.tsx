/**
 * Effective registered-extension state in the Tools panel (BST-1604):
 * the support matrix reflects the GLOBAL dial, and each server row reports the
 * per-server effective state its connection generation advertised.
 */

import '@testing-library/jest-dom/vitest';
import {
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpServerStatusRow } from '../mcp-server-status-row';
import { McpSupportMatrix } from '../mcp-support-status';

const APPS_ID = 'io.modelcontextprotocol/ui';
const TASKS_ID = 'io.modelcontextprotocol/tasks';

function connectedServer(extensions?: McpHostServerSnapshot['extensions']): McpHostServerSnapshot {
  return {
    configuredProtocol: 'auto',
    configuredServerId: parseConfiguredMcpServerId('local'),
    ...(extensions && { extensions }),
    generation: 3,
    negotiated: { era: 'modern', revision: '2026-07-28' },
    state: 'connected',
    transport: 'stdio',
  };
}

describe('McpSupportMatrix extension dials', () => {
  it('reports compiled-in support when no preferences are supplied', () => {
    render(<McpSupportMatrix />);

    expect(screen.getByTestId(`mcp-support-status-${APPS_ID}`)).toHaveTextContent('Supported');
    expect(screen.getByTestId(`mcp-support-status-${TASKS_ID}`)).toHaveTextContent('Supported');
    expect(screen.getByTestId(`mcp-support-row-${APPS_ID}`)).toHaveAttribute(
      'data-status',
      'supported'
    );
  });

  it('reports Disabled for a globally-off extension and Supported for the other', () => {
    render(<McpSupportMatrix extensionPreferences={{ apps: false, tasks: true }} />);

    expect(screen.getByTestId(`mcp-support-status-${APPS_ID}`)).toHaveTextContent('Disabled');
    expect(screen.getByTestId(`mcp-support-row-${APPS_ID}`)).toHaveAttribute(
      'data-status',
      'disabled'
    );
    expect(screen.getByTestId(`mcp-support-row-${APPS_ID}`)).toHaveTextContent(
      'Turned off in settings'
    );
    expect(screen.getByTestId(`mcp-support-status-${TASKS_ID}`)).toHaveTextContent('Supported');
    expect(screen.getByTestId(`mcp-support-row-${TASKS_ID}`)).toHaveAttribute(
      'data-status',
      'supported'
    );
  });

  it('leaves unsupported rows unsupported', () => {
    render(<McpSupportMatrix extensionPreferences={{ apps: false, tasks: false }} />);

    expect(
      screen.getByTestId('mcp-support-status-io.modelcontextprotocol/oauth-client-credentials')
    ).toHaveTextContent('Unsupported');
  });
});

describe('McpServerStatusRow extension diagnostics', () => {
  it('lists the per-server effective state', () => {
    render(
      <McpServerStatusRow
        controlAvailable={false}
        onControl={vi.fn()}
        server={connectedServer({ apps: true, tasks: false })}
      />
    );

    const block = screen.getByTestId('mcp-extensions-local');
    expect(block).toHaveTextContent('MCP Apps: advertised');
    expect(block).toHaveTextContent('MCP Tasks: off');
    expect(block).toHaveAttribute('data-extension-apps', 'on');
    expect(block).toHaveAttribute('data-extension-tasks', 'off');
  });

  it('renders nothing when the snapshot carries no extensions', () => {
    render(
      <McpServerStatusRow controlAvailable={false} onControl={vi.fn()} server={connectedServer()} />
    );

    expect(screen.queryByTestId('mcp-extensions-local')).not.toBeInTheDocument();
  });
});
