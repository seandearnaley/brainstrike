import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPermissionPolicyStoreForTests,
  usePermissionPolicyStore,
} from '../stores/permission-policy-store';

const { PermissionSettingsSection } = await import(
  '../settings/system/permission-settings-section'
);

describe('PermissionSettingsSection', () => {
  beforeEach(() => {
    __resetPermissionPolicyStoreForTests();
  });

  it('renders the enforce toggle, four category controls, and the YOLO toggle', () => {
    render(<PermissionSettingsSection />);

    expect(screen.getByTestId('permission-enforce-toggle')).not.toBeNull();
    expect(screen.getByTestId('permission-yolo-toggle')).not.toBeNull();

    for (const category of ['read', 'edit', 'execute', 'mcp'] as const) {
      expect(screen.getByLabelText(new RegExp(`${category} permission`, 'i'))).not.toBeNull();
    }
  });

  it('renders defaults (enforce ON, read=allow, edit/execute=ask, mcp=allow)', () => {
    render(<PermissionSettingsSection />);

    // enforce-on-by-default (P1 fix).
    expect(screen.getByTestId('permission-enforce-toggle').getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(screen.getByTestId('permission-yolo-toggle').getAttribute('aria-checked')).toBe('false');

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

  it('toggling YOLO updates the store', async () => {
    render(<PermissionSettingsSection />);

    fireEvent.click(screen.getByTestId('permission-yolo-toggle'));

    await waitFor(() => {
      expect(usePermissionPolicyStore.getState().yolo).toBe(true);
    });
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
      usePermissionPolicyStore.getState().setToolOverride('brainstrike.executeCommand', 'allow');
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
      usePermissionPolicyStore.getState().setToolOverride('brainstrike.executeCommand', 'allow');
      usePermissionPolicyStore.getState().setEnforce(false);
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
      usePermissionPolicyStore.getState().setToolOverride('brainstrike.executeCommand', 'allow');
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
  });
});
