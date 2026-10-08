/**
 * Composes the assistant run-lifecycle OS notification pipeline (see
 * docs/agents/assistant-persistence.md "ASSISTANT RUN NOTIFICATIONS"). This is the ONLY layer that
 * reads live browser state (`Notification.permission`) and the notification
 * preferences store — the UI package (`@brainstrike/assistant-ui`) only reports
 * raw run events/approval requests up via callback props, mirroring the existing
 * `onUsage` seam. Whether the user is looking at the app comes from the shared
 * `isAppActive()` (`@brainstrike/hooks`), the same signal the unseen-badge rule
 * reads (BST-1864), so a completion is either seen or alerted, never both.
 *
 * Mounted ONLY by visible assistant surfaces: `AssistantUiPanelWrapper` and
 * desktop's committed agent-host thread view. Desktop's hidden embedding/llm
 * hosts render neither — they mount `EmbeddingHostApp`/`LlmHostApp` — so this
 * hook can never run there and can never notify on their behalf.
 */

import { getNotificationPermissionState } from '@brainstrike/app-state/notifications/notification-permission';
import {
  createRunNotificationDispatcher,
  type ForgeNotificationEvent,
  type RunNotificationEvent,
} from '@brainstrike/app-state/notifications/run-notification-dispatcher';
import { useNotificationPreferencesStore } from '@brainstrike/app-state/stores/notification-preferences-store';
import {
  type AssistantRunEvent,
  type AssistantToolApprovalRequest,
  getToolActionIdentityKey,
} from '@brainstrike/assistant-contract';
import { isAppActive } from '@brainstrike/hooks';
import { useMemo, useState } from 'react';

export interface AssistantRunNotificationCallbacks {
  readonly onForgeEvent: (event: ForgeNotificationEvent) => void;
  readonly onRunFailed: (event: AssistantRunEvent) => void;
  readonly onRunFinished: (event: AssistantRunEvent) => void;
  /** An agent-host thread's committed run event, already in dispatcher terms. */
  readonly onRunNotification: (event: RunNotificationEvent) => void;
  readonly onToolApprovalRequired: (request: AssistantToolApprovalRequest) => void;
}

function readNotificationSettings() {
  const state = useNotificationPreferencesStore.getState();
  return { events: state.events, masterEnabled: state.masterEnabled };
}

export function useAssistantRunNotifications(): AssistantRunNotificationCallbacks {
  // Stable for the panel's lifetime: coalescing (max one notification per
  // run per event kind) is meaningful only within a single dispatcher
  // instance, so it must not be recreated on every render.
  const [dispatcher] = useState(() =>
    createRunNotificationDispatcher({
      getPermissionState: getNotificationPermissionState,
      getSettings: readNotificationSettings,
      isAppActive,
    })
  );

  return useMemo<AssistantRunNotificationCallbacks>(
    () => ({
      onForgeEvent: (event) => {
        dispatcher.dispatch(event);
      },
      onRunFailed: (event) => {
        // Hosted turns carry a `runId`; web local-runtime events
        // (`createLocalRunEvent`) carry only a per-event `id`. The event `id`
        // is a stable, unique coalescing key — an honest fallback, never a
        // fabricated runId that could collide across runs.
        dispatcher.dispatch({ kind: 'runFailed', runId: event.runId ?? event.id });
      },
      onRunFinished: (event) => {
        dispatcher.dispatch({ kind: 'runFinished', runId: event.runId ?? event.id });
      },
      onRunNotification: (event) => {
        dispatcher.dispatch(event);
      },
      onToolApprovalRequired: (request) => {
        dispatcher.dispatch({
          decisionKey: getToolActionIdentityKey(request),
          kind: 'toolApprovalRequired',
          runId: request.runId,
        });
      },
    }),
    [dispatcher]
  );
}
