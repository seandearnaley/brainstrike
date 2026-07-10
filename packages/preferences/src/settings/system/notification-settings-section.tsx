/**
 * Notification settings section (assistant run finished/failed/tool-approval
 * OS notifications — see AGENTS.md "ASSISTANT RUN NOTIFICATIONS").
 *
 * CONSUMES `notification-preferences-store.ts` only — permission handling
 * lives in `../../notifications/notification-permission.ts`. Requests browser
 * notification permission ONLY from this component's toggle-on click (never
 * on mount), and never persists `masterEnabled: true` when the browser denies
 * or has not yet granted permission — the store must never claim "enabled"
 * when notifications cannot actually fire.
 */

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@brainstrike/ui';
import { useState } from 'react';
import {
  type AssistantNotificationPermissionState,
  getNotificationPermissionState,
  requestNotificationPermission,
} from '../../notifications/notification-permission';
import {
  NOTIFICATION_EVENT_KINDS,
  type NotificationEventKind,
  useNotificationPreferencesStore,
} from '../../stores/notification-preferences-store';

interface EventToggleMeta {
  description: string;
  kind: NotificationEventKind;
  label: string;
}

const EVENT_TOGGLE_META: readonly EventToggleMeta[] = [
  {
    description: 'The assistant finished responding.',
    kind: 'runFinished',
    label: 'Run finished',
  },
  {
    description: 'The assistant run ended in an error (including a stalled stream).',
    kind: 'runFailed',
    label: 'Run failed',
  },
  {
    description: 'A tool needs your approval before the run can continue.',
    kind: 'toolApprovalRequired',
    label: 'Tool approval required',
  },
];

function isPermissionBlocked(state: AssistantNotificationPermissionState): boolean {
  return state === 'denied' || state === 'unsupported';
}

function blockedReason(state: AssistantNotificationPermissionState): string | null {
  if (state === 'denied') {
    return 'Blocked by your browser or OS. Allow notifications for this site to turn this on.';
  }
  if (state === 'unsupported') {
    return 'Blocked: this browser does not support notifications.';
  }
  return null;
}

export function NotificationSettingsSection() {
  const masterEnabled = useNotificationPreferencesStore((state) => state.masterEnabled);
  const events = useNotificationPreferencesStore((state) => state.events);
  const setMasterEnabled = useNotificationPreferencesStore((state) => state.setMasterEnabled);
  const setEventEnabled = useNotificationPreferencesStore((state) => state.setEventEnabled);
  const [permissionState, setPermissionState] = useState<AssistantNotificationPermissionState>(() =>
    getNotificationPermissionState()
  );

  const handleMasterToggle = (next: boolean) => {
    if (!next) {
      setMasterEnabled(false);
      return;
    }
    if (permissionState === 'granted') {
      setMasterEnabled(true);
      return;
    }
    // Explicit toggle-on gesture: request permission now, never on load.
    void requestNotificationPermission().then((result) => {
      setPermissionState(result);
      // Never claim enabled unless the browser actually granted permission.
      setMasterEnabled(result === 'granted');
    });
  };

  const blocked = isPermissionBlocked(permissionState);
  const blockedMessage = blockedReason(permissionState);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Show a desktop notification when the assistant finishes a run, a run fails, or a tool
          needs your approval — only while this window is not focused. Off by default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="font-medium text-sm" htmlFor="notifications-master-toggle">
              Enable notifications
            </Label>
            <p className="text-muted-foreground text-sm">
              Requests browser notification permission the first time you turn this on.
            </p>
            {blockedMessage ? (
              <p className="mt-1 text-destructive text-xs">{blockedMessage}</p>
            ) : null}
          </div>
          <Switch
            checked={masterEnabled}
            data-testid="notifications-master-toggle"
            disabled={blocked}
            id="notifications-master-toggle"
            onCheckedChange={(value) => handleMasterToggle(value === true)}
          />
        </div>

        <fieldset className="space-y-3 border-0 p-0" disabled={!masterEnabled}>
          <legend className="font-medium text-sm">Notify me when</legend>
          {NOTIFICATION_EVENT_KINDS.map((kind) => {
            const meta = EVENT_TOGGLE_META.find((entry) => entry.kind === kind);
            if (!meta) {
              return null;
            }
            return (
              <div
                className="flex items-center justify-between gap-4 rounded-md border p-3"
                key={kind}
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm">{meta.label}</p>
                  <p className="text-muted-foreground text-sm">{meta.description}</p>
                </div>
                <Switch
                  checked={events[kind]}
                  data-testid={`notifications-event-${kind}`}
                  disabled={!masterEnabled}
                  onCheckedChange={(value) => setEventEnabled(kind, value === true)}
                />
              </div>
            );
          })}
        </fieldset>
      </CardContent>
    </Card>
  );
}
