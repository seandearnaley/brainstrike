import {
  __resetPermissionPolicyStoreForTests,
  usePermissionPolicyStore,
} from '@brainstrike/app-state/stores/permission-policy-store';
import { act } from '@brainstrike/test-utils/react-act';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { PermissionSettingsSection } = await import(
  '../settings/system/permission-settings-section'
);

describe('PermissionSettingsSection', () => {
  beforeEach(() => {
    __resetPermissionPolicyStoreForTests();
  });

  it('renders the enforce toggle, four category controls, and the access mode', () => {
    render(<PermissionSettingsSection />);

    expect(screen.getByTestId('permission-enforce-toggle')).not.toBeNull();
    expect(screen.getByLabelText('Access mode')).not.toBeNull();
    expect(screen.getByLabelText('Auto-review model')).not.toBeNull();

    for (const category of ['read', 'edit', 'execute', 'mcp'] as const) {
      expect(screen.getByLabelText(new RegExp(`${category} permission`, 'iu'))).not.toBeNull();
    }
  });

  it('renders defaults (enforce ON, read=allow, edit/execute=ask, mcp=allow)', () => {
    render(<PermissionSettingsSection />);

    // enforce-on-by-default (P1 fix).
    expect(screen.getByTestId('permission-enforce-toggle').getAttribute('aria-checked')).toBe(
      'true'
    );
    expect((screen.getByTestId('permission-access-mode') as HTMLSelectElement).value).toBe('ask');
    expect((screen.getByTestId('permission-auto-review-model') as HTMLSelectElement).value).toBe(
      'auto'
    );

    expect((screen.getByTestId('permission-policy-read') as HTMLSelectElement).value).toBe('allow');
    expect((screen.getByTestId('permission-policy-edit') as HTMLSelectElement).value).toBe('ask');
    expect((screen.getByTestId('permission-policy-execute') as HTMLSelectElement).value).toBe(
      'ask'
    );
    expect((screen.getByTestId('permission-policy-mcp') as HTMLSelectElement).value).toBe('allow');
  });

  it('toggling enforce updates the store (off then back on)', async () => {
    render(<PermissionSettingsSection />);

    // Starts ON by default; the first click opts the user OUT.
    expect(usePermissionPolicyStore.getState().enforce).toBe(true);

    fireEvent.click(screen.getByTestId('permission-enforce-toggle'));

    await waitFor(() => {
      expect(usePermissionPolicyStore.getState().enforce).toBe(false);
    });
    expect(screen.getByTestId('permission-enforce-toggle').getAttribute('aria-checked')).toBe(
      'false'
    );
  });

  it('changing a category control calls setCategoryPolicy and reflects store state', async () => {
    render(<PermissionSettingsSection />);

    // Enforce is ON by default, so the category selects are already interactive.
    expect(usePermissionPolicyStore.getState().enforce).toBe(true);

    fireEvent.change(screen.getByTestId('permission-policy-edit'), {
      target: { value: 'deny' },
    });

    await waitFor(() => {
      expect(usePermissionPolicyStore.getState().policies.edit).toBe('deny');
    });
    expect((screen.getByTestId('permission-policy-edit') as HTMLSelectElement).value).toBe('deny');
  });

  it('choosing an access mode updates the store and warns about full access', async () => {
    render(<PermissionSettingsSection />);

    fireEvent.change(screen.getByTestId('permission-access-mode'), {
      target: { value: 'full' },
    });

    await waitFor(() => {
      expect(usePermissionPolicyStore.getState().access).toBe('full');
    });
    expect(screen.getByText('All tools allowed')).not.toBeNull();
  });

  it('disables category controls while enforcement is off', async () => {
    render(<PermissionSettingsSection />);

    // Enforcement is ON by default; opt out so the category controls disable.
    fireEvent.click(screen.getByTestId('permission-enforce-toggle'));
    await waitFor(() => {
      expect(usePermissionPolicyStore.getState().enforce).toBe(false);
    });

    const editSelect = screen.getByTestId('permission-policy-edit') as HTMLSelectElement;
    expect(editSelect.disabled).toBe(true);
  });

  it('enables category controls by default (enforcement on)', () => {
    render(<PermissionSettingsSection />);

    const editSelect = screen.getByTestId('permission-policy-edit') as HTMLSelectElement;
    expect(editSelect.disabled).toBe(false);
  });

  describe('per-tool overrides', () => {
    it('shows an empty-state hint when no overrides exist', () => {
      render(<PermissionSettingsSection />);

      expect(screen.getByTestId('permission-tool-overrides-empty')).not.toBeNull();
    });

    it('lists overrides with a decision select and updates the store on change', async () => {
      await usePermissionPolicyStore
        .getState()
        .setToolOverride('brainstrike.executeCommand', 'allow');
      render(<PermissionSettingsSection />);

      const select = screen.getByTestId(
        'permission-tool-override-brainstrike.executeCommand'
      ) as HTMLSelectElement;
      expect(select.value).toBe('allow');

      fireEvent.change(select, { target: { value: 'deny' } });
      await waitFor(() => {
        expect(
          usePermissionPolicyStore.getState().perToolOverrides['brainstrike.executeCommand']
        ).toBe('deny');
      });
    });

    it('allows removing an override even when enforcement is off (cleanup path)', async () => {
      await usePermissionPolicyStore
        .getState()
        .setToolOverride('brainstrike.executeCommand', 'allow');
      await usePermissionPolicyStore.getState().setEnforce(false);
      render(<PermissionSettingsSection />);

      const removeButton = screen.getByTestId(
        'permission-tool-override-remove-brainstrike.executeCommand'
      ) as HTMLButtonElement;
      expect(removeButton.disabled).toBe(false);

      fireEvent.click(removeButton);
      await waitFor(() => {
        expect(
          usePermissionPolicyStore.getState().perToolOverrides['brainstrike.executeCommand']
        ).toBeUndefined();
      });
    });

    it('removes an override via its Remove button', async () => {
      await usePermissionPolicyStore
        .getState()
        .setToolOverride('brainstrike.executeCommand', 'allow');
      render(<PermissionSettingsSection />);

      fireEvent.click(
        screen.getByTestId('permission-tool-override-remove-brainstrike.executeCommand')
      );
      await waitFor(() => {
        expect(
          usePermissionPolicyStore.getState().perToolOverrides['brainstrike.executeCommand']
        ).toBeUndefined();
      });
      expect(screen.getByTestId('permission-tool-overrides-empty')).not.toBeNull();
    });
  });

  describe('session grants', () => {
    it('shows an empty-state note when no session grants are active', () => {
      render(<PermissionSettingsSection />);

      expect(screen.getByTestId('permission-session-grants-empty')).not.toBeNull();
    });

    it('renders active session grants and revokes one on click', async () => {
      usePermissionPolicyStore.getState().grantSessionCategory('edit');
      usePermissionPolicyStore.getState().grantSessionCategory('execute');
      render(<PermissionSettingsSection />);

      fireEvent.click(screen.getByTestId('permission-session-grant-revoke-edit'));
      await waitFor(() => {
        expect(usePermissionPolicyStore.getState().sessionGrants.has('edit')).toBe(false);
      });
      // The other grant is untouched and still rendered.
      expect(usePermissionPolicyStore.getState().sessionGrants.has('execute')).toBe(true);
      expect(screen.getByTestId('permission-session-grant-revoke-execute')).not.toBeNull();
    });

    it('lists ALL FOUR categories after a blanket grant, each individually revocable', async () => {
      // "Allow all tools this session" is just four category grants — Settings
      // must list them individually so a user can peel one back.
      usePermissionPolicyStore.getState().grantAllSessionCategories();
      render(<PermissionSettingsSection />);

      for (const category of ['read', 'edit', 'execute', 'mcp'] as const) {
        expect(screen.getByTestId(`permission-session-grant-revoke-${category}`)).not.toBeNull();
      }

      fireEvent.click(screen.getByTestId('permission-session-grant-revoke-execute'));
      await waitFor(() => {
        expect(usePermissionPolicyStore.getState().sessionGrants.has('execute')).toBe(false);
      });
      expect(usePermissionPolicyStore.getState().sessionGrants.has('read')).toBe(true);
      expect(usePermissionPolicyStore.getState().sessionGrants.has('edit')).toBe(true);
      expect(usePermissionPolicyStore.getState().sessionGrants.has('mcp')).toBe(true);
    });

    it('offers "Revoke all" which clears every session grant at once', async () => {
      usePermissionPolicyStore.getState().grantAllSessionCategories();
      render(<PermissionSettingsSection />);

      fireEvent.click(screen.getByTestId('permission-session-grants-revoke-all'));
      await waitFor(() => {
        expect(usePermissionPolicyStore.getState().sessionGrants.size).toBe(0);
      });
      expect(screen.getByTestId('permission-session-grants-empty')).not.toBeNull();
    });

    it('hides "Revoke all" when no session grants are active', () => {
      render(<PermissionSettingsSection />);

      expect(screen.queryByTestId('permission-session-grants-revoke-all')).toBeNull();
    });
  });
});

/** A window whose agent host keeps the policy (the desktop): Settings edits only what it loaded. */
describe('PermissionSettingsSection with a host-kept policy', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentHost');
    vi.resetModules();
  });

  async function withHostStorage(storage: {
    getItem: () => Promise<string | null>;
    removeItem: () => Promise<void>;
    setItem: (name: string, value: string) => Promise<void>;
  }) {
    vi.resetModules();
    (window as Window & { agentHost?: unknown }).agentHost = {};
    const store = await import('@brainstrike/app-state/stores/permission-policy-store');
    const section = await import('../settings/system/permission-settings-section');
    store.provideHostPermissionPolicyPersistence(storage);
    return { section, store };
  }

  it('waits for the saved policy before accepting changes', async () => {
    const read = Promise.withResolvers<string | null>();
    const { section } = await withHostStorage({
      getItem: () => read.promise,
      removeItem: async () => undefined,
      setItem: async () => undefined,
    });
    render(<section.PermissionSettingsSection />);
    expect(screen.queryByTestId('permission-policy-edit')).toBeNull();
    expect(screen.getByRole('status')).not.toBeNull();
    await act(async () => {
      read.resolve(null);
      await read.promise;
    });
    await waitFor(() =>
      expect((screen.getByTestId('permission-policy-edit') as HTMLSelectElement).disabled).toBe(
        false
      )
    );
  });

  it('shows a failed policy read and lets the user retry before editing', async () => {
    let failing = true;
    const { section } = await withHostStorage({
      getItem: async () => {
        if (failing) {
          throw new Error('Policy connection closed');
        }
        return null;
      },
      removeItem: async () => undefined,
      setItem: async () => undefined,
    });
    render(<section.PermissionSettingsSection />);
    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    expect(screen.queryByTestId('permission-policy-edit')).toBeNull();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('permission-policy-edit')).not.toBeNull());
  });

  it('shows a choice once the host saved it, and why when it did not', async () => {
    const commit = Promise.withResolvers<void>();
    let refuse = false;
    const { section } = await withHostStorage({
      getItem: async () => null,
      removeItem: async () => undefined,
      setItem: async () => {
        if (refuse) {
          throw new Error('The agent host is closing');
        }
        await commit.promise;
      },
    });
    render(<section.PermissionSettingsSection />);
    const edit = (await screen.findByTestId('permission-policy-edit')) as HTMLSelectElement;

    fireEvent.change(edit, { target: { value: 'deny' } });
    expect(edit.value).toBe('ask');
    await act(async () => {
      commit.resolve();
      await commit.promise;
    });
    await waitFor(() => expect(edit.value).toBe('deny'));

    refuse = true;
    fireEvent.change(edit, { target: { value: 'allow' } });
    expect((await screen.findByTestId('permission-policy-save-error')).textContent).toContain(
      'The agent host is closing'
    );
    expect(edit.value).toBe('deny');
  });
});
