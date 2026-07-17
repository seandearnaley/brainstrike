import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetNotificationPreferencesStoreForTests,
  useNotificationPreferencesStore,
} from '../stores/notification-preferences-store';

const { NotificationSettingsSection } = await import(
  '../settings/system/notification-settings-section'
);

function stubNotification(value: { permission: string; requestPermission: () => Promise<string> }) {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value,
  });
}

describe('NotificationSettingsSection', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

  beforeEach(() => {
    __resetNotificationPreferencesStoreForTests();
  });

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'Notification', originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }
  });

  it('renders the master toggle off by default and the three per-event toggles', () => {
    stubNotification({ permission: 'default', requestPermission: vi.fn(async () => 'granted') });
    render(<NotificationSettingsSection />);

    expect(screen.getByTestId('notifications-master-toggle').getAttribute('aria-checked')).toBe(
      'false'
    );
    expect(screen.getByTestId('notifications-event-runFinished')).not.toBeNull();
    expect(screen.getByTestId('notifications-event-runFailed')).not.toBeNull();
    expect(screen.getByTestId('notifications-event-toolApprovalRequired')).not.toBeNull();
  });

  it('per-event toggles are disabled while the master toggle is off', () => {
    stubNotification({ permission: 'default', requestPermission: vi.fn(async () => 'granted') });
    render(<NotificationSettingsSection />);

    expect(
      (screen.getByTestId('notifications-event-runFinished') as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('requests browser permission on the toggle-on gesture and enables when granted', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    stubNotification({ permission: 'default', requestPermission });
    render(<NotificationSettingsSection />);

    fireEvent.click(screen.getByTestId('notifications-master-toggle'));

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(useNotificationPreferencesStore.getState().masterEnabled).toBe(true);
    });
  });

  it('never persists enabled when the browser denies permission, and surfaces a blocked message', async () => {
    const requestPermission = vi.fn(async () => 'denied');
    stubNotification({ permission: 'default', requestPermission });
    render(<NotificationSettingsSection />);

    fireEvent.click(screen.getByTestId('notifications-master-toggle'));

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
    });
    expect(useNotificationPreferencesStore.getState().masterEnabled).toBe(false);
    expect(screen.getByText(/blocked/i)).not.toBeNull();
  });

  it('reflects an already-denied browser permission immediately, without waiting for a toggle', () => {
    stubNotification({ permission: 'denied', requestPermission: vi.fn(async () => 'denied') });
    render(<NotificationSettingsSection />);

    expect(screen.getByText(/blocked/i)).not.toBeNull();
    expect((screen.getByTestId('notifications-master-toggle') as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('turning the master toggle off does not re-request permission', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    stubNotification({ permission: 'granted', requestPermission });
    useNotificationPreferencesStore.getState().setMasterEnabled(true);
    render(<NotificationSettingsSection />);

    fireEvent.click(screen.getByTestId('notifications-master-toggle'));

    await waitFor(() => {
      expect(useNotificationPreferencesStore.getState().masterEnabled).toBe(false);
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('toggling a per-event switch updates the store', async () => {
    stubNotification({ permission: 'granted', requestPermission: vi.fn(async () => 'granted') });
    useNotificationPreferencesStore.getState().setMasterEnabled(true);
    render(<NotificationSettingsSection />);

    fireEvent.click(screen.getByTestId('notifications-event-runFailed'));

    await waitFor(() => {
      expect(useNotificationPreferencesStore.getState().events.runFailed).toBe(false);
    });
  });
});
