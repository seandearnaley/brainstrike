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

export interface AssistantNotificationFocusState {
  readonly hasFocus: boolean;
  readonly visibilityState: 'visible' | 'hidden';
}

export interface AssistantNotificationSettingsSnapshot {
  readonly events: NotificationEventToggles;
  readonly masterEnabled: boolean;
}

export interface ShouldNotifyInput {
  readonly focusState: AssistantNotificationFocusState;
  readonly kind: NotificationEventKind;
  readonly permissionState: AssistantNotificationPermissionState;
  readonly settings: AssistantNotificationSettingsSnapshot;
}

/**
 * True only when the renderer is NOT the user's active focus: the tab is
 * hidden, or it is visible but the OS window lacks focus (e.g. another app is
 * frontmost). A focused, visible user is NEVER notified — per requirement,
 * this check runs at event time (the caller passes a fresh snapshot).
 */
function isUnfocused(focusState: AssistantNotificationFocusState): boolean {
  return focusState.visibilityState === 'hidden' || !focusState.hasFocus;
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
  return isUnfocused(input.focusState);
}
