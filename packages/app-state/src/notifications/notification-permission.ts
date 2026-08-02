/**
 * Thin wrapper around the browser `Notification` permission surface. Kept
 * separate from `should-notify.ts` so the pure decision gate never touches a
 * browser global directly, and separate from the settings UI so the actual
 * `requestPermission()` gesture call site stays explicit (requirement:
 * request permission ONLY on the user's toggle-on click, never on load).
 */

import type { AssistantNotificationPermissionState } from './should-notify';

export type { AssistantNotificationPermissionState } from './should-notify';

interface NotificationPermissionApi {
  readonly permission: string;
  readonly requestPermission?: () => Promise<string>;
}

function getNotificationApi(): NotificationPermissionApi | undefined {
  const globalWithNotification = globalThis as typeof globalThis & {
    // biome-ignore lint/style/useNamingConvention: matches the real global `Notification` constructor's name.
    Notification?: NotificationPermissionApi;
  };
  return globalWithNotification.Notification;
}

function toPermissionState(value: string): AssistantNotificationPermissionState {
  if (value === 'granted' || value === 'denied' || value === 'default') {
    return value;
  }
  // An unrecognized value from a nonstandard implementation is treated as
  // unsupported rather than guessed at (NO GUESSING / NO HAND WAVING).
  return 'unsupported';
}

/** Reads the CURRENT permission state. Never triggers a permission prompt. */
export function getNotificationPermissionState(): AssistantNotificationPermissionState {
  const api = getNotificationApi();
  if (!api) {
    return 'unsupported';
  }
  return toPermissionState(api.permission);
}

/**
 * Requests notification permission. Must only be called from an explicit
 * user gesture (the Settings toggle-on click) — never on app load.
 */
export async function requestNotificationPermission(): Promise<AssistantNotificationPermissionState> {
  const api = getNotificationApi();
  if (!(api && typeof api.requestPermission === 'function')) {
    return 'unsupported';
  }
  const result = await api.requestPermission();
  return toPermissionState(result);
}
