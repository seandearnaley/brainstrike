import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getNotificationPermissionState,
  requestNotificationPermission,
} from '../notifications/notification-permission';

function stubNotification(value: {
  permission: string;
  requestPermission?: () => Promise<string>;
}) {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value,
  });
}

describe('getNotificationPermissionState', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'Notification', originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }
  });

  it('reports "unsupported" when window.Notification does not exist', () => {
    Reflect.deleteProperty(globalThis, 'Notification');
    expect(getNotificationPermissionState()).toBe('unsupported');
  });

  it('reads the live Notification.permission value', () => {
    stubNotification({ permission: 'granted' });
    expect(getNotificationPermissionState()).toBe('granted');

    stubNotification({ permission: 'denied' });
    expect(getNotificationPermissionState()).toBe('denied');

    stubNotification({ permission: 'default' });
    expect(getNotificationPermissionState()).toBe('default');
  });

  it('treats an unrecognized permission string as "unsupported" rather than guessing', () => {
    stubNotification({ permission: 'weird-value' });
    expect(getNotificationPermissionState()).toBe('unsupported');
  });
});

describe('requestNotificationPermission', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'Notification', originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }
  });

  it('resolves "unsupported" without calling anything when the API is absent', async () => {
    Reflect.deleteProperty(globalThis, 'Notification');
    await expect(requestNotificationPermission()).resolves.toBe('unsupported');
  });

  it('delegates to Notification.requestPermission and returns its result', async () => {
    const requestPermission = vi.fn(async () => 'granted');
    stubNotification({ permission: 'default', requestPermission });

    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('surfaces denial verbatim', async () => {
    const requestPermission = vi.fn(async () => 'denied');
    stubNotification({ permission: 'default', requestPermission });

    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });
});
