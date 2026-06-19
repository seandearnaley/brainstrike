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
});
