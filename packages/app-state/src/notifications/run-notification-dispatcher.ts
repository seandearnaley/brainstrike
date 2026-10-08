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
  AssistantNotificationPermissionState,
  AssistantNotificationSettingsSnapshot,
} from './should-notify';
import { shouldNotify } from './should-notify';

interface RunNotificationEventBase {
  readonly runId: string;
  /** Thread title only — never message content. Falls back to "Assistant". */
  readonly threadTitle?: string;
}

type RunNotificationEventKind = Exclude<NotificationEventKind, 'prChecks' | 'prOpened'>;

/** The canonical decision key coalesces root and child views of the same leaf. */
export type RunNotificationEvent =
  | (RunNotificationEventBase & {
      readonly kind: Exclude<RunNotificationEventKind, 'toolApprovalRequired'>;
    })
  | (RunNotificationEventBase & {
      readonly kind: 'toolApprovalRequired';
      readonly decisionKey: string;
      /** What the run waits on when it is not a tool approval; the one toggle governs all. */
      readonly input?: 'plan' | 'question';
    });

/**
 * A forge (pull request) observation. It has NO run: the observation comes
 * from the main-process ForgeService, not from a run stream, so this variant
 * deliberately carries no `runId` rather than fabricating one.
 *
 * `observationKey` is the coalescing identity —
 * `<repoCommonDir>\0<branch>\0<headSha>` (the `\0` separator matches
 * `forge-service.ts`'s own `cacheKey` convention — BST-1391 L9) — so
 * re-observing the SAME head never re-notifies, while a new push does.
 */
export interface ForgeNotificationEvent {
  readonly checksOutcome?: 'failing' | 'passing';
  readonly kind: 'prChecks' | 'prOpened';
  readonly observationKey: string;
  readonly prNumber: number;
  /** Thread title only — never message content. */
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
  readonly getPermissionState: () => AssistantNotificationPermissionState;
  readonly getSettings: () => AssistantNotificationSettingsSnapshot;
  /** The shared app-active signal, read at dispatch time (event time). */
  readonly isAppActive: () => boolean;
  /** Defaults to the global `Notification` constructor. Injectable for tests. */
  readonly notificationFactory?: NotificationFactory;
}

export interface RunNotificationDispatcher {
  /** Evaluates the gates and shows (at most once per run+kind) a notification. */
  dispatch: (event: ForgeNotificationEvent | RunNotificationEvent) => void;
  /** Forgets every prior dispatch key, letting a repeated event notify again. */
  resetCoalescing: () => void;
}

const EVENT_PHRASE: Record<NotificationEventKind, string> = {
  prChecks: 'Checks finished.',
  prOpened: 'Opened a pull request.',
  runFailed: 'Run failed.',
  runFinished: 'Finished responding.',
  toolApprovalRequired: 'Needs your approval to continue.',
};

const INPUT_PHRASE = {
  plan: 'Has a plan for your review.',
  question: 'Has a question for you.',
} as const;

function isForgeEvent(
  event: ForgeNotificationEvent | RunNotificationEvent
): event is ForgeNotificationEvent {
  return event.kind === 'prOpened' || event.kind === 'prChecks';
}

function buildNotificationCopy(event: ForgeNotificationEvent | RunNotificationEvent): {
  readonly body: string;
  readonly title: string;
} {
  const title = event.threadTitle?.trim() ? event.threadTitle : 'Assistant';
  if (isForgeEvent(event)) {
    if (event.kind === 'prOpened') {
      return { body: `Opened pull request #${event.prNumber}.`, title };
    }
    const verb = event.checksOutcome === 'failing' ? 'failed' : 'passed';
    return { body: `Checks ${verb} on pull request #${event.prNumber}.`, title };
  }
  if (event.kind === 'toolApprovalRequired' && event.input) {
    return { body: INPUT_PHRASE[event.input], title };
  }
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

function coalesceKey(event: ForgeNotificationEvent | RunNotificationEvent): string {
  if (isForgeEvent(event)) {
    return `${event.observationKey}:${event.kind}`;
  }
  if (event.kind === 'toolApprovalRequired') {
    // Per-approval, not per-run: a second distinct approval pause in the same
    // run must still notify a backgrounded user.
    return `${event.kind}:${event.decisionKey}`;
  }
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
        appActive: deps.isAppActive(),
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
