/**
 * Composes the assistant run-lifecycle OS notification pipeline (see
 * AGENTS.md "ASSISTANT RUN NOTIFICATIONS"). This is the ONLY layer that
 * reads live browser state (`document.hasFocus`/`visibilityState`,
 * `Notification.permission`) and the notification preferences store — the
 * UI package (`@brainstrike/ui/assistant-ui-panel`) only reports raw run
 * events/approval requests up via callback props, mirroring the existing
 * `onUsage` seam.
 *
 * Mounted ONLY from `AssistantUiPanelWrapper` (the visible assistant
 * surface). Desktop's hidden embedding/llm hosts never render that wrapper —
 * they mount `EmbeddingHostApp`/`LlmHostApp`, which never import
 * `AssistantUiPanel` — so this hook can never run there and can never
 * notify on their behalf.
 */

import type {
  AssistantRunEvent,
  AssistantToolApprovalRequest,
} from '@brainstrike/assistant-contract';
import { getNotificationPermissionState } from '@brainstrike/preferences/notifications/notification-permission';
import { createRunNotificationDispatcher } from '@brainstrike/preferences/notifications/run-notification-dispatcher';
import type { AssistantNotificationFocusState } from '@brainstrike/preferences/notifications/should-notify';
import { useNotificationPreferencesStore } from '@brainstrike/preferences/stores/notification-preferences-store';
import { useMemo, useRef } from 'react';

export interface AssistantRunNotificationCallbacks {
  readonly onRunFailed: (event: AssistantRunEvent) => void;
  readonly onRunFinished: (event: AssistantRunEvent) => void;
  readonly onToolApprovalRequired: (request: AssistantToolApprovalRequest) => void;
}

function readFocusState(): AssistantNotificationFocusState {
  return {
    hasFocus: document.hasFocus(),
    visibilityState: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
  };
}

function readNotificationSettings() {
  const state = useNotificationPreferencesStore.getState();
  return { events: state.events, masterEnabled: state.masterEnabled };
}

export function useAssistantRunNotifications(): AssistantRunNotificationCallbacks {
  // Stable for the panel's lifetime: coalescing (max one notification per
  // run per event kind) is meaningful only within a single dispatcher
  // instance, so it must not be recreated on every render.
  const dispatcherRef = useRef(
    createRunNotificationDispatcher({
      getFocusState: readFocusState,
      getPermissionState: getNotificationPermissionState,
      getSettings: readNotificationSettings,
    })
  );

  return useMemo<AssistantRunNotificationCallbacks>(
    () => ({
      onRunFailed: (event) => {
        // Hosted turns carry a `runId`; web local-runtime events
        // (`createLocalRunEvent`) carry only a per-event `id`. The event `id`
        // is a stable, unique coalescing key — an honest fallback, never a
        // fabricated runId that could collide across runs.
        dispatcherRef.current.dispatch({ kind: 'runFailed', runId: event.runId ?? event.id });
      },
      onRunFinished: (event) => {
        dispatcherRef.current.dispatch({ kind: 'runFinished', runId: event.runId ?? event.id });
      },
      onToolApprovalRequired: (request) => {
        dispatcherRef.current.dispatch({
          kind: 'toolApprovalRequired',
          runId: request.runId,
          toolCallId: request.toolCallId,
        });
      },
    }),
    []
  );
}
