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
      'Worktrees are unavailable in this window'
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

  it.each(['"', "'"])('rejects setup commands containing %s as they are typed', async (quote) => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    const command = screen.getByTestId('worktree-settings-setup-command');
    await user.type(command, `sh -c ${quote}pnpm install`);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Quoting is not supported. Each whitespace-separated token becomes one argument.'
    );
    expect(screen.getByTestId('worktree-settings-save')).toBeDisabled();
    await user.click(screen.getByTestId('worktree-settings-save'));
    expect(onSave).not.toHaveBeenCalled();

    await user.clear(command);
    await user.type(command, 'pnpm install');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('worktree-settings-save')).toBeEnabled();
  });

  it('offers Save only once something changed', async () => {
    const user = userEvent.setup();
    render(
      <WorktreeSettingsSection onSave={vi.fn()} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    const save = screen.getByTestId('worktree-settings-save');
    expect(save).toBeDisabled();

    await user.type(screen.getByTestId('worktree-settings-setup-command'), 'pnpm install');
    expect(save).toBeEnabled();

    await user.clear(screen.getByTestId('worktree-settings-setup-command'));
    expect(save).toBeDisabled();
  });

  it('shows Saving… while the save runs, then Saved until the next edit', async () => {
    const user = userEvent.setup();
    const pending = Promise.withResolvers<void>();
    const onSave = vi.fn(() => pending.promise);
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    const command = screen.getByTestId('worktree-settings-setup-command');
    await user.type(command, 'pnpm install');
    await user.click(screen.getByTestId('worktree-settings-save'));

    expect(screen.getByTestId('worktree-settings-save')).toHaveTextContent('Saving…');
    expect(screen.queryByText('Saved')).toBeNull();
    pending.resolve();
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
    expect(screen.getByTestId('worktree-settings-save')).toHaveTextContent('Save');

    await user.type(command, ' --frozen-lockfile');
    expect(screen.queryByRole('status')).toBeNull();
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
    await user.type(screen.getByTestId('worktree-settings-directory'), '/inside');
    await user.click(screen.getByTestId('worktree-settings-save'));
    expect(await screen.findByTestId('worktree-settings-error')).toHaveTextContent(
      'must not live inside the granted folder'
    );
  });
});
