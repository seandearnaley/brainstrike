/**
 * Coalescing dispatcher that turns an assistant run-lifecycle event into (at
 * most) one OS `Notification`. Consumes `shouldNotify` for the gating
 * decision; owns only the coalescing key and the privacy-safe copy.
 *
 * PRIVACY: the input `RunNotificationEvent` never carries message content or
 * tool arguments — only `runId`/`kind`/an optional `threadTitle`. This is
 * enforced by the type itself (no `args`/`text`/`result` field exists to
 * leak), not by filtering, so a future caller cannot accidentally widen it.
 */

import type { NotificationEventKind } from '../stores/notification-preferences-store';
import type {
  AssistantNotificationFocusState,
  AssistantNotificationPermissionState,
  AssistantNotificationSettingsSnapshot,
} from './should-notify';
import { shouldNotify } from './should-notify';

export interface RunNotificationEvent {
  readonly kind: NotificationEventKind;
  readonly runId: string;
  /** Thread title only — never message content. Falls back to "Assistant". */
  readonly threadTitle?: string;
}

/** Minimal surface of the DOM `Notification` instance the dispatcher needs. */
export interface DispatchedNotificationHandle {
  onclick: (() => void) | null;
}

export type NotificationFactory = (
  title: string,
  options: NotificationOptions
) => DispatchedNotificationHandle;

export interface RunNotificationDispatcherDeps {
  /** Called when the user clicks the notification. Defaults to `window.focus`. */
  readonly focusWindow?: () => void;
  readonly getFocusState: () => AssistantNotificationFocusState;
  readonly getPermissionState: () => AssistantNotificationPermissionState;
  readonly getSettings: () => AssistantNotificationSettingsSnapshot;
  /** Defaults to the global `Notification` constructor. Injectable for tests. */
  readonly notificationFactory?: NotificationFactory;
}

export interface RunNotificationDispatcher {
  /** Evaluates the gates and shows (at most once per run+kind) a notification. */
  dispatch: (event: RunNotificationEvent) => void;
  /** Forgets every prior dispatch key, letting a repeated event notify again. */
  resetCoalescing: () => void;
}

const EVENT_PHRASE: Record<NotificationEventKind, string> = {
  runFailed: 'Run failed.',
  runFinished: 'Finished responding.',
  toolApprovalRequired: 'Needs your approval to continue.',
};

function buildNotificationCopy(event: RunNotificationEvent): {
  readonly title: string;
  readonly body: string;
} {
  const title = event.threadTitle?.trim() ? event.threadTitle : 'Assistant';
  return { body: EVENT_PHRASE[event.kind], title };
}

/**
 * Wraps a real `Notification` in a plain object rather than returning it
 * directly, so `DispatchedNotificationHandle` never has to structurally match
 * the DOM lib's `(this: Notification, ev: Event) => any` handler signature —
 * this dispatcher only ever needs a zero-argument click callback.
 */
function defaultNotificationFactory(
  title: string,
  options: NotificationOptions
): DispatchedNotificationHandle {
  const instance = new Notification(title, options);
  return {
    set onclick(handler: (() => void) | null) {
      instance.onclick = handler ? () => handler() : null;
    },
  } as DispatchedNotificationHandle;
}

function defaultFocusWindow(): void {
  window.focus();
}

function coalesceKey(event: RunNotificationEvent): string {
  return `${event.runId}:${event.kind}`;
}

export function createRunNotificationDispatcher(
  deps: RunNotificationDispatcherDeps
): RunNotificationDispatcher {
  const notificationFactory = deps.notificationFactory ?? defaultNotificationFactory;
  const focusWindow = deps.focusWindow ?? defaultFocusWindow;
  let dispatchedKeys = new Set<string>();

  return {
    dispatch: (event) => {
      const key = coalesceKey(event);
      // Marked BEFORE evaluating the gates so coalescing is unconditional: a
      // duplicate `dispatch` call for the same run+kind (e.g. a re-rendered
      // stream part) never re-evaluates focus/permission, let alone shows a
      // second notification.
      if (dispatchedKeys.has(key)) {
        return;
      }
      dispatchedKeys.add(key);

      const permitted = shouldNotify({
        focusState: deps.getFocusState(),
        kind: event.kind,
        permissionState: deps.getPermissionState(),
        settings: deps.getSettings(),
      });
      if (!permitted) {
        return;
      }

      const { title, body } = buildNotificationCopy(event);
      const handle = notificationFactory(title, { body, tag: key });
      handle.onclick = () => {
        focusWindow();
      };
    },
    resetCoalescing: () => {
      dispatchedKeys = new Set<string>();
    },
  };
}
