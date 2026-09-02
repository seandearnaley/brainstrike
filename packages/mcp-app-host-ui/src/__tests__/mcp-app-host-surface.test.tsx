// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { McpAppProvenanceAuthority, McpAppToolCallAuthority } from '@brainstrike/mcp-app-host';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { McpAppHostSurface } from '../index';

function createAuthority() {
  const provenance = new McpAppProvenanceAuthority();
  const generation = provenance.openGeneration({ generation: 1, serverId: 'linear' });
  provenance.registerTool(generation, {
    _meta: { ui: { visibility: ['app'] } },
    name: 'create_issue',
  });
  const execute = vi.fn(async () => ({ content: [] }));
  const authority = new McpAppToolCallAuthority({
    generation,
    prepare: async () => ({ decision: 'ask', execute, riskCategory: 'execute' }),
    provenance,
    release: async () => undefined,
  });
  return { authority, execute };
}

describe('MCP Apps host surface', () => {
  it('renders truthful loading, failure, retry, cancellation, and completion states', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const cancel = vi.fn();
    const recoveryRef = createRef<HTMLButtonElement>();
    const { authority } = createAuthority();
    const view = render(
      <>
        <button ref={recoveryRef} type="button">
          Return target
        </button>
        <McpAppHostSurface
          appName="Linear issue editor"
          authority={authority}
          onCancel={cancel}
          recoveryFocusRef={recoveryRef}
          state={{ phase: 'loading' }}
        />
      </>
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading Linear issue editor');
    await user.click(screen.getByRole('button', { name: 'Cancel Linear issue editor' }));
    expect(cancel).toHaveBeenCalledOnce();

    view.rerender(
      <>
        <button ref={recoveryRef} type="button">
          Return target
        </button>
        <McpAppHostSurface
          appName="Linear issue editor"
          authority={authority}
          onRetry={retry}
          recoveryFocusRef={recoveryRef}
          state={{ code: 'protocol-failed', phase: 'error' }}
        />
      </>
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The app could not start safely.');
    const retryButton = screen.getByRole('button', { name: 'Retry Linear issue editor' });
    await waitFor(() => expect(retryButton).toHaveFocus());
    await user.click(retryButton);
    expect(retry).toHaveBeenCalledOnce();

    view.rerender(
      <>
        <button ref={recoveryRef} type="button">
          Return target
        </button>
        <McpAppHostSurface
          appName="Linear issue editor"
          authority={authority}
          recoveryFocusRef={recoveryRef}
          state={{ phase: 'cancelled' }}
        />
      </>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Linear issue editor was cancelled.');
    expect(recoveryRef.current).toHaveFocus();

    view.rerender(
      <>
        <button ref={recoveryRef} type="button">
          Return target
        </button>
        <McpAppHostSurface
          appName="Linear issue editor"
          authority={authority}
          recoveryFocusRef={recoveryRef}
          state={{ phase: 'completed' }}
        />
      </>
    );
    expect(screen.getByRole('status')).toHaveTextContent('Linear issue editor completed.');
  });

  it('keeps focus on Deny across unrelated authority publishes', async () => {
    const user = userEvent.setup();
    const recoveryRef = createRef<HTMLButtonElement>();
    const { authority } = createAuthority();
    render(
      <>
        <button aria-label="Linear app frame" ref={recoveryRef} type="button" />
        <McpAppHostSurface
          appName="Linear issue editor"
          authority={authority}
          recoveryFocusRef={recoveryRef}
          state={{ phase: 'ready' }}
        >
          <div data-testid="sandboxed-app-slot" />
        </McpAppHostSurface>
      </>
    );
    await act(async () => {
      void authority
        .call({ arguments: {}, id: 'first-call', name: 'create_issue' })
        .catch(() => undefined);
      await Promise.resolve();
    });
    await screen.findByRole('alertdialog');
    const denyButton = screen.getByRole('button', { name: 'Deny create_issue' });
    await user.tab({ shift: true });
    denyButton.focus();
    expect(denyButton).toHaveFocus();

    // A second concurrent call queues another approval and publishes a new
    // snapshot; the open dialog's focus must not move.
    await act(async () => {
      void authority
        .call({ arguments: {}, id: 'second-call', name: 'create_issue' })
        .catch(() => undefined);
      await Promise.resolve();
    });
    await screen.findByText(/1 more request/u);
    expect(denyButton).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeInTheDocument());
    await authority.close();
  });

  it('focuses explicit consent, exposes no arguments, and restores focus after allow or deny', async () => {
    const user = userEvent.setup();
    const recoveryRef = createRef<HTMLButtonElement>();
    const { authority, execute } = createAuthority();
    render(
      <>
        <button aria-label="Linear app frame" ref={recoveryRef} type="button" />
        <McpAppHostSurface
          appName="Linear issue editor"
          authority={authority}
          recoveryFocusRef={recoveryRef}
          state={{ phase: 'ready' }}
        >
          <div data-testid="sandboxed-app-slot" />
        </McpAppHostSurface>
      </>
    );
    recoveryRef.current?.focus();

    let denied: Promise<Readonly<Record<string, unknown>>> | undefined;
    await act(async () => {
      denied = authority.call({
        arguments: { title: 'Secret issue', token: 'must-not-render' },
        id: 'deny-call',
        name: 'create_issue',
      });
      void denied.catch(() => undefined);
      await Promise.resolve();
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Allow Linear issue editor to use create_issue?');
    expect(dialog).toHaveTextContent('This execute action requires your approval.');
    expect(dialog).not.toHaveTextContent('must-not-render');
    expect(dialog).not.toHaveTextContent('Secret issue');
    const denyButton = screen.getByRole('button', { name: 'Deny create_issue' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Allow create_issue once' })).toHaveFocus()
    );
    await user.tab();
    expect(denyButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Allow create_issue once' })).toHaveFocus();
    await user.click(denyButton);
    await expect(denied).rejects.toMatchObject({ code: -32_001 });
    await waitFor(() => expect(recoveryRef.current).toHaveFocus());
    expect(execute).not.toHaveBeenCalled();

    let allowed: Promise<Readonly<Record<string, unknown>>> | undefined;
    await act(async () => {
      allowed = authority.call({ arguments: {}, id: 'allow-call', name: 'create_issue' });
      await Promise.resolve();
    });
    const allowButton = await screen.findByRole('button', { name: 'Allow create_issue once' });
    await user.click(allowButton);
    await expect(allowed).resolves.toEqual({ content: [] });
    await waitFor(() => expect(recoveryRef.current).toHaveFocus());
    expect(execute).toHaveBeenCalledOnce();
  });
});
