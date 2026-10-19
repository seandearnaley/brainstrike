import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpCatalogSection } from '../mcp-catalog-section';

const PATH = '/tmp/mcp.config.json';

function props(overrides: Partial<Parameters<typeof McpCatalogSection>[0]> = {}) {
  return {
    configuredServerIds: new Set<string>(),
    installMcpCatalogServer: vi.fn(async () => ({
      path: PATH,
      revision: 'installed',
      success: true as const,
    })),
    onInstalled: vi.fn(async () => undefined),
    ...overrides,
  };
}

function card(id: string) {
  return within(screen.getByTestId(`mcp-catalog-card-${id}`));
}

afterEach(cleanup);

describe('MCP catalog section', () => {
  it('lists the four vendors and offers read-only only on Linear and GitHub', async () => {
    render(<McpCatalogSection {...props()} />);

    for (const id of ['linear', 'github', 'atlassian', 'gitlab']) {
      expect(await screen.findByTestId(`mcp-catalog-card-${id}`)).toBeInTheDocument();
    }
    expect(card('linear').getByRole('tab', { name: 'Read-only' })).toBeInTheDocument();
    expect(card('github').getByRole('tab', { name: 'Read-only' })).toBeInTheDocument();
    expect(card('atlassian').queryByRole('tab')).not.toBeInTheDocument();
    expect(card('gitlab').queryByRole('tab')).not.toBeInTheDocument();
    expect(card('github').getByText('Token')).toBeInTheDocument();
    expect(card('linear').getByText('OAuth')).toBeInTheDocument();
  });

  it('installs with the chosen access, then reloads the editor', async () => {
    const p = props();
    render(<McpCatalogSection {...p} />);

    fireEvent.mouseDown(await card('linear').findByRole('tab', { name: 'Read-only' }));
    fireEvent.click(card('linear').getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(p.onInstalled).toHaveBeenCalledExactlyOnceWith('Linear'));
    expect(p.installMcpCatalogServer).toHaveBeenCalledWith({
      access: 'read-only',
      catalogId: 'linear',
    });
  });

  it('marks an already configured server Installed with no Install button', async () => {
    render(<McpCatalogSection {...props({ configuredServerIds: new Set(['gitlab']) })} />);

    expect(await screen.findByTestId('mcp-catalog-installed-gitlab')).toHaveTextContent(
      'Installed'
    );
    expect(card('gitlab').queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('flips a card to Installed when the status owner pushes a new id set', async () => {
    const p = props();
    const { rerender } = render(<McpCatalogSection {...p} />);
    expect(await card('github').findByRole('button', { name: 'Install' })).toBeEnabled();

    rerender(<McpCatalogSection {...p} configuredServerIds={new Set(['github'])} />);

    expect(await screen.findByTestId('mcp-catalog-installed-github')).toHaveTextContent(
      'Installed'
    );
    expect(card('github').queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    expect(card('github').queryByRole('tab')).not.toBeInTheDocument();
  });

  it('sends a pasted GitHub token once, trimmed, and closes the dialog', async () => {
    const p = props();
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('github').findByRole('button', { name: 'Install' }));
    const field = await screen.findByLabelText('Fine-grained personal access token');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: '  github_pat_fixture  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(p.installMcpCatalogServer).toHaveBeenCalledWith({
        access: 'read-write',
        catalogId: 'github',
        token: 'github_pat_fixture',
      })
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Fine-grained personal access token')).not.toBeInTheDocument()
    );
    expect(p.installMcpCatalogServer).toHaveBeenCalledTimes(1);
  });

  it('clears the token from the field before the install settles, and after it fails', async () => {
    const install = Promise.withResolvers<{ error: string; path: string; success: false }>();
    const p = props({ installMcpCatalogServer: vi.fn(() => install.promise) });
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('github').findByRole('button', { name: 'Install' }));
    const field = await screen.findByLabelText('Fine-grained personal access token');
    fireEvent.change(field, { target: { value: 'github_pat_fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(p.installMcpCatalogServer).toHaveBeenCalledOnce();
    expect(field).toHaveValue('');
    await act(async () => {
      install.resolve({ error: 'The keychain refused the token.', path: PATH, success: false });
    });

    expect(screen.getByLabelText('Fine-grained personal access token')).toHaveValue('');
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(
      'The keychain refused the token.'
    );
  });

  it('shows the host refusal on the card and keeps Install available', async () => {
    const p = props({
      installMcpCatalogServer: vi.fn(async () => ({
        error: 'An MCP server named "atlassian" is already configured.',
        path: PATH,
        success: false as const,
      })),
    });
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('atlassian').findByRole('button', { name: 'Install' }));

    expect(await screen.findByTestId('mcp-catalog-error-atlassian')).toHaveTextContent(
      'An MCP server named "atlassian" is already configured.'
    );
    expect(card('atlassian').getByRole('button', { name: 'Install' })).toBeEnabled();
    expect(p.onInstalled).not.toHaveBeenCalled();
  });

  it('keeps a successful OAuth install a success and reports a failed Settings refresh apart', async () => {
    const p = props({
      onInstalled: vi.fn(async () => {
        throw new Error('refresh failed');
      }),
    });
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('atlassian').findByRole('button', { name: 'Install' }));

    expect(await screen.findByTestId('mcp-catalog-refresh-error')).toHaveTextContent(
      'Atlassian was installed, but Settings could not refresh: refresh failed'
    );
    expect(screen.getByTestId('mcp-catalog-refresh-error')).toHaveAttribute('role', 'alert');
    expect(p.installMcpCatalogServer).toHaveBeenCalledExactlyOnceWith({
      access: 'read-write',
      catalogId: 'atlassian',
    });
    expect(screen.queryByTestId('mcp-catalog-error-atlassian')).not.toBeInTheDocument();
  });

  it('closes the GitHub token dialog when the install succeeded but the Settings refresh failed', async () => {
    const p = props({
      onInstalled: vi.fn(async () => {
        throw new Error('refresh failed');
      }),
    });
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('github').findByRole('button', { name: 'Install' }));
    fireEvent.change(await screen.findByLabelText('Fine-grained personal access token'), {
      target: { value: 'github_pat_fixture' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('mcp-catalog-refresh-error')).toHaveTextContent(
      'GitHub was installed, but Settings could not refresh: refresh failed'
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('Fine-grained personal access token')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-catalog-error-github')).not.toBeInTheDocument();
  });

  it('clears the Settings refresh failure when a later install starts', async () => {
    const p = props({
      onInstalled: vi
        .fn<(serverName: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error('refresh failed'))
        .mockResolvedValue(undefined),
    });
    render(<McpCatalogSection {...p} />);

    fireEvent.click(await card('atlassian').findByRole('button', { name: 'Install' }));
    expect(await screen.findByTestId('mcp-catalog-refresh-error')).toBeInTheDocument();
    fireEvent.click(card('gitlab').getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(p.onInstalled).toHaveBeenLastCalledWith('GitLab'));
    expect(screen.queryByTestId('mcp-catalog-refresh-error')).not.toBeInTheDocument();
  });

  it('blocks installs while the config editor holds unsaved text', async () => {
    render(
      <McpCatalogSection
        {...props({ blockedReason: 'Save or reload the config editor before installing.' })}
      />
    );

    expect(await screen.findByTestId('mcp-catalog-blocked')).toHaveTextContent(
      'Save or reload the config editor before installing.'
    );
    expect(card('linear').getByRole('button', { name: 'Install' })).toBeDisabled();
  });

  it('shows a link that failed to open on the card instead of dropping it', async () => {
    const openExternal = vi.fn(async () => ({ error: 'Blocked by policy', ok: false }));
    Object.assign(window, { platform: { openExternal } });
    try {
      render(<McpCatalogSection {...props()} />);
      fireEvent.click(await card('gitlab').findByRole('link', { name: 'Docs' }));

      expect(await screen.findByTestId('mcp-catalog-error-gitlab')).toHaveTextContent(
        "Couldn't open link: Blocked by policy"
      );
      expect(openExternal).toHaveBeenCalledWith(
        'https://docs.gitlab.com/user/model_context_protocol/mcp_server/'
      );
    } finally {
      Reflect.deleteProperty(window, 'platform');
    }
  });
});
