import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeSettingsSection } from '../settings/system/worktree-settings-section';

const SETTINGS = {
  isDefaultDirectory: true,
  managedDirectory: '/home/me/.brainstrike/worktrees',
  setupCommand: null,
};

describe('WorktreeSettingsSection', () => {
  it('states the reason instead of a form when the capability is absent', () => {
    render(
      <WorktreeSettingsSection onSave={vi.fn()} settings={null} status={{ kind: 'unavailable' }} />
    );
    expect(screen.getByTestId('worktree-settings-unavailable')).toHaveTextContent(
      'Worktrees are a desktop feature.'
    );
    expect(screen.queryByTestId('worktree-settings-directory')).toBeNull();
  });

  it('renders the load error verbatim rather than an empty form', () => {
    render(
      <WorktreeSettingsSection
        onSave={vi.fn()}
        settings={null}
        status={{ kind: 'error', message: 'worktreeSettings is not valid JSON.' }}
      />
    );
    expect(screen.getByTestId('worktree-settings-error')).toHaveTextContent(
      'worktreeSettings is not valid JSON.'
    );
  });

  it('shows the resolved directory and marks it as the default', () => {
    render(
      <WorktreeSettingsSection onSave={vi.fn()} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    expect(screen.getByTestId('worktree-settings-directory')).toHaveValue(
      '/home/me/.brainstrike/worktrees'
    );
    expect(screen.getByTestId('worktree-settings-default-badge')).toBeVisible();
  });

  it('shows the resolved directory after loading completes', () => {
    const { rerender } = render(
      <WorktreeSettingsSection onSave={vi.fn()} settings={null} status={{ kind: 'loading' }} />
    );

    rerender(
      <WorktreeSettingsSection
        onSave={vi.fn()}
        settings={{ ...SETTINGS, setupCommand: ['pnpm', 'install'] }}
        status={{ kind: 'ready' }}
      />
    );

    expect(screen.getByTestId('worktree-settings-directory')).toHaveValue(
      '/home/me/.brainstrike/worktrees'
    );
    expect(screen.getByTestId('worktree-settings-setup-command')).toHaveValue('pnpm install');
  });

  it('saves an explicit directory', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    const input = screen.getByTestId('worktree-settings-directory');
    await user.clear(input);
    await user.type(input, '/volumes/work/wt');
    await user.click(screen.getByTestId('worktree-settings-save'));
    expect(onSave).toHaveBeenCalledWith({
      managedDirectory: '/volumes/work/wt',
      setupCommand: null,
    });
  });

  it('saves the explicit disabled setup state', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );

    await user.click(screen.getByTestId('worktree-settings-disable-setup'));
    await user.click(screen.getByTestId('worktree-settings-save'));

    expect(onSave).toHaveBeenCalledWith({
      managedDirectory: '/home/me/.brainstrike/worktrees',
      setupCommand: 'disabled',
    });
  });

  it('reflects a persisted disabled setup state on initial render', () => {
    render(
      <WorktreeSettingsSection
        onSave={vi.fn()}
        settings={{ ...SETTINGS, setupCommand: 'disabled' }}
        status={{ kind: 'ready' }}
      />
    );

    expect(screen.getByTestId('worktree-settings-disable-setup')).toBeChecked();
    expect(screen.getByTestId('worktree-settings-setup-command')).toBeDisabled();
    expect(screen.getByTestId('worktree-settings-setup-command-preview')).toHaveTextContent(
      'Setup is disabled.'
    );
  });

  it.each(['"', "'"])('rejects setup commands containing %s without saving', async (quote) => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    const command = screen.getByTestId('worktree-settings-setup-command');
    await user.type(command, `sh -c ${quote}pnpm install${quote}`);
    await user.click(screen.getByTestId('worktree-settings-save'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Quoting is not supported. Each whitespace-separated token becomes one argument.'
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the live whitespace-split argv preview', async () => {
    const user = userEvent.setup();
    render(
      <WorktreeSettingsSection onSave={vi.fn()} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    const command = screen.getByTestId('worktree-settings-setup-command');
    await user.type(command, 'pnpm install --frozen-lockfile');

    expect(screen.getByTestId('worktree-settings-setup-command-preview')).toHaveTextContent(
      'Runs as: [pnpm, install, --frozen-lockfile]'
    );
  });

  it('resets to the default', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <WorktreeSettingsSection
        onSave={onSave}
        settings={{ ...SETTINGS, isDefaultDirectory: false, managedDirectory: '/x' }}
        status={{ kind: 'ready' }}
      />
    );
    await user.click(screen.getByTestId('worktree-settings-reset'));
    expect(onSave).toHaveBeenCalledWith({ managedDirectory: null, setupCommand: null });
  });

  it('surfaces a save failure verbatim', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() =>
      Promise.reject(
        new Error('Managed worktrees must not live inside the granted folder "/work/app"')
      )
    );
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    await user.click(screen.getByTestId('worktree-settings-save'));
    expect(await screen.findByTestId('worktree-settings-error')).toHaveTextContent(
      'must not live inside the granted folder'
    );
  });
});
