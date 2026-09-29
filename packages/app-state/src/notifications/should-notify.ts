/**
 * Pure decision logic for assistant run-lifecycle OS notifications. See
 * docs/agents/assistant-persistence.md "ASSISTANT RUN NOTIFICATIONS" for the full contract. Kept free of
 * zustand/browser globals so every gate is unit-testable without mocking
 * `window`/`Notification`.
 */

import type {
  NotificationEventKind,
  NotificationEventToggles,
} from '../stores/notification-preferences-store';

/**
 * Mirrors the standard `NotificationPermission` union plus `'unsupported'` for
 * environments (or browsers) where `window.Notification` does not exist at
 * all — distinct from `'default'` (API present, user hasn't decided yet).
 */
export type AssistantNotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface AssistantNotificationSettingsSnapshot {
  readonly events: NotificationEventToggles;
  readonly masterEnabled: boolean;
}

export interface ShouldNotifyInput {
  /**
   * The shared `isAppActive()` reading (`@brainstrike/hooks`) taken at event
   * time: visible AND focused, where focus is the native window's on desktop.
   * The unseen-badge rule reads the same signal.
   */
  readonly appActive: boolean;
  readonly kind: NotificationEventKind;
  readonly permissionState: AssistantNotificationPermissionState;
  readonly settings: AssistantNotificationSettingsSnapshot;
}

/**
 * The single gate every dispatch path must call before constructing a
 * `Notification`. Every branch is a hard `false` (no partial/silent
 * degradation) — a caller cannot accidentally show a notification when any
 * gate is unmet.
 */
export function shouldNotify(input: ShouldNotifyInput): boolean {
  if (!input.settings.masterEnabled) {
    return false;
  }
  if (!input.settings.events[input.kind]) {
    return false;
  }
  if (input.permissionState !== 'granted') {
    return false;
  }
  // A visible, focused user is NEVER notified; the caller passes a fresh reading.
  return !input.appActive;
}
