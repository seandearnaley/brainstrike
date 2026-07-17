/**
 * Assistant run-notification preferences (OS `Notification` API, run
 * finished/failed/tool-approval-required — see docs/agents/assistant-persistence.md "ASSISTANT RUN
 * NOTIFICATIONS").
 *
 * - `masterEnabled` — top-level opt-in. Defaults OFF: notifications are a new,
 *   OS-level side effect and must never surprise an existing user. PERSISTED.
 * - `events` — per-event-kind toggle, each defaulting to ON so turning the
 *   master switch on gives every event immediately (per requirements). Only
 *   meaningful while `masterEnabled` is true. PERSISTED.
 *
 * Deliberately holds state only: the browser `Notification.requestPermission()`
 * gesture, the focus/visibility gates, and the actual `new Notification(...)`
 * dispatch live in `../notifications/*` and the settings UI — this store never
 * calls a browser API itself, so it stays trivially testable and SSR-safe.
 *
 * Factory reset: the persisted slice is wiped by `clearPersistentUiState`'s
 * blanket `localStorage.clear()` (see `factory-reset-helpers.ts`), and the live
 * store is reset explicitly via `resetNotificationPreferencesStoreToDefaults`,
 * which `clearPersistentUiState` invokes (mirrors `permission-policy-store`) so
 * an in-memory master-enabled toggle never survives a reset that does not
 * reload the page (FACTORY RESET CONTRACT).
 */

import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export const NOTIFICATION_EVENT_KINDS = [
  'runFinished',
  'runFailed',
  'toolApprovalRequired',
] as const;

export type NotificationEventKind = (typeof NOTIFICATION_EVENT_KINDS)[number];

export type NotificationEventToggles = Record<NotificationEventKind, boolean>;

interface NotificationPreferencesData {
  /** Per-event-kind toggle. Only consulted while `masterEnabled` is true. PERSISTED. */
  events: NotificationEventToggles;
  /** Master opt-in switch. Defaults OFF. PERSISTED. */
  masterEnabled: boolean;
}

interface NotificationPreferencesActions {
  resetToDefaults: () => void;
  setEventEnabled: (kind: NotificationEventKind, enabled: boolean) => void;
  setMasterEnabled: (enabled: boolean) => void;
}

export type NotificationPreferencesStore = NotificationPreferencesData &
  NotificationPreferencesActions;

const STORE_NAME = 'notification-preferences.v1' as const;
const STORE_VERSION = 1 as const;

function defaultEvents(): NotificationEventToggles {
  return {
    runFailed: true,
    runFinished: true,
    toolApprovalRequired: true,
  };
}

function defaultData(): NotificationPreferencesData {
  return {
    events: defaultEvents(),
    masterEnabled: false,
  };
}

function isNotificationEventKind(value: string): value is NotificationEventKind {
  return (NOTIFICATION_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Coerce an unknown persisted `events` value into a complete, valid record.
 * Unknown keys are dropped; missing or malformed entries fall back to the
 * (ON) default for that event, so a malformed payload cannot wedge the UI.
 */
function sanitizeEvents(value: unknown): NotificationEventToggles {
  const result = defaultEvents();
  if (!value || typeof value !== 'object') {
    return result;
  }
  const candidate = value as Record<string, unknown>;
  for (const kind of NOTIFICATION_EVENT_KINDS) {
    const entry = candidate[kind];
    if (typeof entry === 'boolean') {
      result[kind] = entry;
    }
  }
  return result;
}

const storage = createJSONStorage(() => createBrowserJsonStorage());

export const useNotificationPreferencesStore = create<NotificationPreferencesStore>()(
  persist(
    (set) => ({
      ...defaultData(),
      resetToDefaults: () => set(defaultData()),
      setEventEnabled: (kind, enabled) =>
        set((state) => ({ events: { ...state.events, [kind]: enabled } })),
      setMasterEnabled: (enabled) => set({ masterEnabled: enabled }),
    }),
    {
      migrate: (persistedState) => {
        if (!(persistedState && typeof persistedState === 'object')) {
          return defaultData();
        }
        const candidate = persistedState as Partial<NotificationPreferencesData>;
        return {
          events: sanitizeEvents(candidate.events),
          masterEnabled:
            typeof candidate.masterEnabled === 'boolean' ? candidate.masterEnabled : false,
        } satisfies NotificationPreferencesData;
      },
      name: STORE_NAME,
      partialize: (state) => ({
        events: state.events,
        masterEnabled: state.masterEnabled,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

export const notificationPreferencesSelectors = {
  events: (store: NotificationPreferencesStore): NotificationEventToggles => store.events,
  masterEnabled: (store: NotificationPreferencesStore): boolean => store.masterEnabled,
};

/**
 * Resets the live store to defaults AND clears its persisted slice. Invoked by
 * the factory-reset pipeline (FACTORY RESET CONTRACT).
 */
export function resetNotificationPreferencesStoreToDefaults(): void {
  try {
    const persistApi = (
      useNotificationPreferencesStore as typeof useNotificationPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Best effort: storage errors must not block the reset of in-memory state.
  }
  useNotificationPreferencesStore.setState(defaultData());
}

export { isNotificationEventKind };

/** Test-only reset helper. */
export function __resetNotificationPreferencesStoreForTests(): void {
  resetNotificationPreferencesStoreToDefaults();
}
