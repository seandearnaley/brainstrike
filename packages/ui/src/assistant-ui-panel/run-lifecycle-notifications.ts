/**
 * Trigger source for assistant run-lifecycle OS notifications (run
 * finished/failed, tool approval required — see AGENTS.md "ASSISTANT RUN
 * NOTIFICATIONS"). This module only REPORTS raw events up via callback props,
 * mirroring the existing `onUsage` seam (`data-stream-runtime.ts` ->
 * `AssistantUiPanelProps.onUsage` -> app-shell's `handleUsage`) — the actual
 * notification DECISION (settings gate, permission, coalescing) lives in
 * `@brainstrike/preferences/notifications/*`, composed by app-shell. This
 * package never touches `window.Notification` or the preferences store.
 *
 * `useRunLifecycleNotifications` is mounted exactly once per panel instance
 * (alongside `AssistantDataRendererRegistration` in `assistant-ui-panel.tsx`),
 * so it only ever runs inside the VISIBLE assistant surface — desktop's
 * hidden embedding/llm hosts never mount `AssistantUiPanel` at all, which is
 * what keeps them from ever notifying (verified: neither
 * `embedding-host-app.tsx` nor `llm-host-app.tsx` imports it).
 */

import { useAuiState } from '@assistant-ui/react';
import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { useEffect, useRef } from 'react';
import { getMessageParts } from './assistant-run-timeline';

export interface RunLifecycleNotificationCallbacks {
  readonly onRunFailed?: (event: AssistantRunEvent) => void;
  readonly onRunFinished?: (event: AssistantRunEvent) => void;
  readonly onToolApprovalRequired?: (request: AssistantToolApprovalRequest) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Minimal validator — only the fields this module reads, not the full shape. */
function isTerminalRunEvent(value: unknown): value is AssistantRunEvent {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['kind'] === 'run.finished' || value['kind'] === 'run.failed') &&
    typeof value['label'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['timestamp'] === 'string'
  );
}

function isToolApprovalRequest(value: unknown): value is AssistantToolApprovalRequest {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['toolName'] === 'string'
  );
}

function getPartData(part: unknown, name: string): unknown {
  if (!isRecord(part) || part['name'] !== name) {
    return;
  }
  return part['data'];
}

/**
 * Every `run.finished`/`run.failed` event across the thread, in the order
 * they appear. Malformed data parts are skipped (never thrown) since a
 * notification trigger must never crash the panel over a shape mismatch.
 */
export function selectTerminalRunEvents(
  messages: readonly unknown[]
): readonly AssistantRunEvent[] {
  const events: AssistantRunEvent[] = [];
  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      const data = getPartData(part, ASSISTANT_RUN_EVENT_DATA_NAME);
      if (isTerminalRunEvent(data)) {
        events.push(data);
      }
    }
  }
  return events;
}

/**
 * Every distinct tool-approval-required request across the thread
 * (deduped by `runId:toolCallId`, first occurrence wins — the pause is a
 * point-in-time event, so a later re-render of the same part must not be
 * treated as a new approval request).
 */
export function selectToolApprovalRequests(
  messages: readonly unknown[]
): readonly AssistantToolApprovalRequest[] {
  const seen = new Set<string>();
  const requests: AssistantToolApprovalRequest[] = [];
  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      const data = getPartData(part, TOOL_APPROVAL_DATA_NAME);
      if (!isToolApprovalRequest(data)) {
        continue;
      }
      const key = `${data.runId}:${data.toolCallId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      requests.push(data);
    }
  }
  return requests;
}

/**
 * `useAuiState` compares its selector's return value with `Object.is` and
 * REQUIRES either a primitive or a referentially-stable reference — returning
 * a freshly-built array/object on every call (as `selectTerminalRunEvents`
 * does) re-renders on every store update and blows the update-depth limit.
 * Serializing to a string sidesteps that: two equal strings compare equal by
 * value, so the selector is only ever "changed" when the underlying events
 * actually differ.
 */
function serializeTerminalRunEvents(messages: readonly unknown[]): string {
  return JSON.stringify(selectTerminalRunEvents(messages));
}

function serializeToolApprovalRequests(messages: readonly unknown[]): string {
  return JSON.stringify(selectToolApprovalRequests(messages));
}

/**
 * Reports each NEW terminal run event / tool-approval request exactly once
 * (tracked via refs, so remounts within the same panel instance don't
 * re-fire for events already seen). Never dedupes ACROSS panel instances —
 * that's the dispatcher's job (see `createRunNotificationDispatcher`).
 *
 * Hydration guard: reload hydration re-weaves EVERY historical run-event /
 * approval data part into `state.thread.messages` (see AGENTS.md "ASSISTANT
 * THREAD PERSISTENCE & RELOAD HYDRATION"), so the effect's first invocation
 * for a given thread always sees the full replayed history, not just brand
 * new activity. That first invocation seeds the "seen" sets from the
 * snapshot WITHOUT firing callbacks; only events that land in a later
 * invocation are genuinely new and notify. `threadKey` (the panel's
 * `threadKey` prop) marks thread switches so a later switch re-seeds against
 * the new thread's history instead of treating it as a replay of the
 * previous thread.
 */
export function useRunLifecycleNotifications(
  callbacks: RunLifecycleNotificationCallbacks,
  threadKey?: string
): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const terminalEventsJson = useAuiState((state) =>
    serializeTerminalRunEvents(state.thread.messages)
  );
  const approvalRequestsJson = useAuiState((state) =>
    serializeToolApprovalRequests(state.thread.messages)
  );

  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seededEventsThreadRef = useRef(false);
  const seededEventsThreadKeyRef = useRef<string | undefined>(threadKey);
  // biome-ignore lint/plugin: reports render-derived events to a parent callback (mirrors onUsage); must run in an effect, not render, since it has an external side effect.
  useEffect(() => {
    const events = JSON.parse(terminalEventsJson) as AssistantRunEvent[];
    const isThreadSwitch =
      seededEventsThreadRef.current && seededEventsThreadKeyRef.current !== threadKey;
    if (!seededEventsThreadRef.current || isThreadSwitch) {
      // First invocation for this mount/thread, or a switch to a different
      // thread: seed the baseline from already-present (replayed) events
      // without notifying, then track ONLY genuinely new events from here.
      seenEventIdsRef.current = new Set(events.map((event) => event.id));
      seededEventsThreadRef.current = true;
      seededEventsThreadKeyRef.current = threadKey;
      return;
    }
    for (const event of events) {
      if (seenEventIdsRef.current.has(event.id)) {
        continue;
      }
      seenEventIdsRef.current.add(event.id);
      if (event.kind === 'run.finished') {
        callbacksRef.current.onRunFinished?.(event);
      } else {
        callbacksRef.current.onRunFailed?.(event);
      }
    }
  }, [terminalEventsJson, threadKey]);

  const seenApprovalKeysRef = useRef<Set<string>>(new Set());
  const seededApprovalsThreadRef = useRef(false);
  const seededApprovalsThreadKeyRef = useRef<string | undefined>(threadKey);
  // biome-ignore lint/plugin: same rationale as the run-event effect above.
  useEffect(() => {
    const requests = JSON.parse(approvalRequestsJson) as AssistantToolApprovalRequest[];
    const isThreadSwitch =
      seededApprovalsThreadRef.current && seededApprovalsThreadKeyRef.current !== threadKey;
    if (!seededApprovalsThreadRef.current || isThreadSwitch) {
      seenApprovalKeysRef.current = new Set(
        requests.map((request) => `${request.runId}:${request.toolCallId}`)
      );
      seededApprovalsThreadRef.current = true;
      seededApprovalsThreadKeyRef.current = threadKey;
      return;
    }
    for (const request of requests) {
      const key = `${request.runId}:${request.toolCallId}`;
      if (seenApprovalKeysRef.current.has(key)) {
        continue;
      }
      seenApprovalKeysRef.current.add(key);
      callbacksRef.current.onToolApprovalRequired?.(request);
    }
  }, [approvalRequestsJson, threadKey]);
}

/** Always-mounted, render-nothing bridge — see module doc for placement. */
export function RunLifecycleNotificationBridge(
  props: RunLifecycleNotificationCallbacks & { readonly threadKey?: string }
) {
  const { threadKey, ...callbacks } = props;
  useRunLifecycleNotifications(callbacks, threadKey);
  return null;
}
