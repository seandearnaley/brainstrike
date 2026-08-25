import '@testing-library/jest-dom';
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
