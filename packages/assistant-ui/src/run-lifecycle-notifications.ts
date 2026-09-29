/**
 * Trigger source for assistant run-lifecycle OS notifications (run
 * finished/failed, tool approval required — see docs/agents/assistant-persistence.md "ASSISTANT RUN
 * NOTIFICATIONS"). This module only REPORTS raw events up via callback props,
 * mirroring the existing `onUsage` seam (`data-stream-runtime.ts` ->
 * `AssistantUiPanelProps.onUsage` -> app-shell's `handleUsage`) — the actual
 * notification DECISION (settings gate, permission, coalescing) lives in
 * `@brainstrike/app-state/notifications/*`, composed by app-shell. This
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
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  getToolActionIdentityKey,
  isDelegatedToolActionIdentity,
  readAssistantRunEvent,
} from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import {
  buildNativeToolRiskMap,
  denormalizeNativeToolName,
} from '@brainstrike/assistant-contract/tool-metadata';
import { useEffect, useRef, useState } from 'react';
import { getMessageParts } from './assistant-run-event-derivation';

export interface RunLifecycleNotificationCallbacks {
  /**
   * LIVE run activity that can have changed files on disk (BST-1115 smoke
   * feedback), reported AS IT HAPPENS rather than at the end of the run:
   * `run.started`, and every `tool.completed`/`subagent.tool.completed` for a
   * native tool the shared registry classifies `riskCategory: 'edit'`.
   *
   * This is the seam the Changes surface's live "Last Turn" refresh consumes
   * — a run-scoped observation this module already has (it scans the same
   * streamed run-event data parts for the terminal events), so nothing polls
   * and no new transport is invented. Deliberately reports the raw event and
   * makes no decision: which of these matter, and what to do about them, is
   * app-shell's business exactly as the notification DECISION already is.
   */
  readonly onRunEditActivity?: (event: AssistantRunEvent) => void;
  readonly onRunFailed?: (event: AssistantRunEvent) => void;
  readonly onRunFinished?: (event: AssistantRunEvent) => void;
  readonly onToolApprovalRequired?: (request: AssistantToolApprovalRequest) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readTerminalRunEvent(value: unknown): AssistantRunEvent | undefined {
  // Contract narrow (BST-978 slice 2: metadata degrades, never drops) + this
  // module's kind filter.
  const event = readAssistantRunEvent(value);
  return event && (event.kind === 'run.finished' || event.kind === 'run.failed')
    ? event
    : undefined;
}

/**
 * Native tool ids the shared registry classifies `riskCategory: 'edit'` —
 * the tools whose completion can have written the edit-checkpoint journal.
 *
 * Derived from the registry, never hand-listed: a new mutation tool must not
 * be able to ship without the live Changes view noticing it. Built LAZILY on
 * first use rather than at module scope, so importing this module never runs
 * registry initialization during chunk evaluation.
 */
let editRiskToolIds: ReadonlySet<string> | undefined;

function isEditRiskToolName(toolName: unknown): boolean {
  if (typeof toolName !== 'string') {
    return false;
  }
  if (!editRiskToolIds) {
    const riskByTool = buildNativeToolRiskMap();
    editRiskToolIds = new Set(
      Object.entries(riskByTool)
        .filter(([, risk]) => risk === 'edit')
        .map(([toolId]) => toolId)
    );
  }
  // The live stream carries dotted native ids; persisted/replayed parts carry
  // the Mastra-sanitized form. `denormalizeNativeToolName` is the canonical
  // reverse for known native ids and passes anything else through unchanged.
  return editRiskToolIds.has(denormalizeNativeToolName(toolName));
}

/**
 * A run-event that means "files on disk may have just changed": the run
 * beginning (the view should retarget to it immediately, in-progress) or a
 * completed edit-risk tool call, including one a subagent made.
 */
function readEditActivityRunEvent(value: unknown): AssistantRunEvent | undefined {
  const event = readAssistantRunEvent(value);
  if (!event) {
    return;
  }
  if (event.kind === 'run.started') {
    return event;
  }
  if (event.kind !== 'tool.completed' && event.kind !== 'subagent.tool.completed') {
    return;
  }
  return isEditRiskToolName(event.metadata?.['toolName']) ? event : undefined;
}

function isToolApprovalRequest(value: unknown): value is AssistantToolApprovalRequest {
  return (
    isRecord(value) &&
    typeof value['runId'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['toolName'] === 'string' &&
    (!('delegation' in value) ||
      (Object.hasOwn(value, 'delegation') && isDelegatedToolActionIdentity(value['delegation'])))
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
      const event = readTerminalRunEvent(getPartData(part, ASSISTANT_RUN_EVENT_DATA_NAME));
      if (event) {
        events.push(event);
      }
    }
  }
  return events;
}

/**
 * Every distinct tool-approval-required request across the thread
 * (deduped by the leaf decision identity, first occurrence wins — the pause is a
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
      const key = getToolActionIdentityKey(data);
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
interface ScannedMessage {
  readonly id: string | undefined;
  readonly partCount: number;
}

function shouldResetIncrementalScan(
  messages: readonly unknown[],
  partsByMessage: readonly (readonly unknown[])[],
  scannedMessages: readonly ScannedMessage[]
): boolean {
  if (messages.length < scannedMessages.length) {
    return true;
  }
  for (let index = 0; index < scannedMessages.length; index += 1) {
    const previous = scannedMessages[index];
    const message = messages[index];
    const parts = partsByMessage[index];
    if (!(previous && message && parts)) {
      return true;
    }
    if (getMessageId(message) !== previous.id || parts.length < previous.partCount) {
      return true;
    }
    if (index < scannedMessages.length - 1 && parts.length !== previous.partCount) {
      return true;
    }
  }
  return false;
}

function appendIncrementalMatches<T>({
  getData,
  getKey,
  messages,
  partsByMessage,
  scannedMessages,
  seenKeys,
  values,
}: {
  getData: (part: unknown) => T | undefined;
  getKey: ((value: T) => string) | undefined;
  messages: readonly unknown[];
  partsByMessage: readonly (readonly unknown[])[];
  scannedMessages: readonly ScannedMessage[];
  seenKeys: Set<string>;
  values: T[];
}): boolean {
  let matched = false;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const parts = partsByMessage[messageIndex];
    if (!parts) {
      continue;
    }
    const start = scannedMessages[messageIndex]?.partCount ?? 0;
    for (let partIndex = start; partIndex < parts.length; partIndex += 1) {
      const value = getData(parts[partIndex]);
      if (value === undefined) {
        continue;
      }
      const key = getKey?.(value);
      if (key !== undefined && seenKeys.has(key)) {
        continue;
      }
      if (key !== undefined) {
        seenKeys.add(key);
      }
      values.push(value);
      matched = true;
    }
  }
  return matched;
}

function getMessageId(message: unknown): string | undefined {
  return isRecord(message) && typeof message['id'] === 'string' ? message['id'] : undefined;
}

function createIncrementalSerializedSelector<T>({
  getData,
  getKey,
}: {
  getData: (part: unknown) => T | undefined;
  getKey?: (value: T) => string;
}): (messages: readonly unknown[]) => string {
  let scannedMessages: ScannedMessage[] = [];
  let values: T[] = [];
  let serialized = '[]';
  let seenKeys = new Set<string>();

  return (messages) => {
    const partsByMessage = messages.map(getMessageParts);
    const reset = shouldResetIncrementalScan(messages, partsByMessage, scannedMessages);

    if (reset) {
      scannedMessages = [];
      values = [];
      seenKeys = new Set();
    }

    const matched = appendIncrementalMatches({
      getData,
      getKey,
      messages,
      partsByMessage,
      scannedMessages,
      seenKeys,
      values,
    });

    scannedMessages = messages.map((message, index) => ({
      id: getMessageId(message),
      partCount: partsByMessage[index]?.length ?? 0,
    }));
    if (matched || reset) {
      serialized = JSON.stringify(values);
    }
    return serialized;
  };
}

export function createTerminalRunEventsSelector(): (messages: readonly unknown[]) => string {
  return createIncrementalSerializedSelector({
    getData: (part) => readTerminalRunEvent(getPartData(part, ASSISTANT_RUN_EVENT_DATA_NAME)),
  });
}

export function createEditActivityRunEventsSelector(): (messages: readonly unknown[]) => string {
  return createIncrementalSerializedSelector({
    getData: (part) => readEditActivityRunEvent(getPartData(part, ASSISTANT_RUN_EVENT_DATA_NAME)),
    getKey: (event) => event.id,
  });
}

export function createToolApprovalRequestsSelector(): (messages: readonly unknown[]) => string {
  return createIncrementalSerializedSelector({
    getData: (part) => {
      const data = getPartData(part, TOOL_APPROVAL_DATA_NAME);
      return isToolApprovalRequest(data) ? data : undefined;
    },
    getKey: getToolActionIdentityKey,
  });
}

/**
 * Report each value in `values` whose key has not been seen yet, ONCE.
 *
 * Shared by every stream observation this module makes (terminal run events,
 * tool-approval requests, and live edit activity) because the seeding
 * discipline is identical for all three and must not drift between them: while
 * history is hydrating, neither seed nor report; on the first settled pass for
 * a mount — or after a `threadKey` switch — seed the baseline from whatever is
 * already replayed WITHOUT reporting it; only afterwards report genuinely new
 * values.
 */
function useNewStreamValues<T>(args: {
  isHistoryLoading: boolean;
  keyOf: (value: T) => string;
  onNew: (value: T) => void;
  serializedValues: string;
  threadKey: string | undefined;
}): void {
  const { isHistoryLoading, serializedValues, threadKey } = args;
  const handlersRef = useRef(args);
  // Latest-ref sync happens in an (unconditional) effect, not during render —
  // React Doctor `no-ref-current-in-render`. Declaration order guarantees this
  // runs before the deps-gated effect below on every commit, so that effect
  // always reads the freshest handlers.
  useEffect(() => {
    handlersRef.current = args;
  });

  const seenKeysRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const seededThreadKeyRef = useRef<string | undefined>(threadKey);

  useEffect(() => {
    if (isHistoryLoading) {
      // History is still hydrating; defer seeding so the baseline captures the
      // full replayed snapshot instead of an empty one.
      return;
    }
    const { keyOf, onNew } = handlersRef.current;
    const values = JSON.parse(serializedValues) as T[];
    const isThreadSwitch = seededRef.current && seededThreadKeyRef.current !== threadKey;
    if (!seededRef.current || isThreadSwitch) {
      // First invocation for this mount/thread, or a switch to a different
      // thread: seed the baseline from already-present (replayed) values
      // without notifying, then track ONLY genuinely new ones from here.
      seenKeysRef.current = new Set(values.map(keyOf));
      seededRef.current = true;
      seededThreadKeyRef.current = threadKey;
      return;
    }
    for (const value of values) {
      const key = keyOf(value);
      if (seenKeysRef.current.has(key)) {
        continue;
      }
      seenKeysRef.current.add(key);
      onNew(value);
    }
  }, [serializedValues, threadKey, isHistoryLoading]);
}

/**
 * Reports each NEW terminal run event / tool-approval request / live edit
 * activity event exactly once (tracked via refs, so remounts within the same
 * panel instance don't re-fire for events already seen). Never dedupes ACROSS
 * panel instances — that's the dispatcher's job (see
 * `createRunNotificationDispatcher`).
 *
 * Hydration guard: reload hydration re-weaves EVERY historical run-event /
 * approval data part into `state.thread.messages` (see docs/agents/assistant-persistence.md "ASSISTANT
 * THREAD PERSISTENCE & RELOAD HYDRATION"), so the seeded baseline must capture
 * the full replayed history before any callback fires. The history adapter
 * loads that history ASYNCHRONOUSLY — opening an existing thread first renders
 * with an empty snapshot while `state.thread.isLoading` is true, then the
 * persisted parts land on a later update. Seeding is therefore DEFERRED until
 * `isLoading` is false: while loading we neither seed nor notify, so the
 * hydrated history seeds the baseline (no replay) and only genuinely new
 * activity after that notifies. A brand-new thread never loads history
 * (`isLoading` stays false) and seeds an empty baseline immediately.
 * `threadKey` (the panel's `threadKey` prop) marks thread switches so a later
 * switch re-seeds against the new thread's history instead of treating it as a
 * replay of the previous thread. {@link useNewStreamValues} owns that
 * discipline for all three observations so it cannot drift between them.
 */
export function useRunLifecycleNotifications(
  callbacks: RunLifecycleNotificationCallbacks,
  threadKey?: string
): void {
  const [selectTerminalEventsJson] = useState(createTerminalRunEventsSelector);
  const [selectApprovalRequestsJson] = useState(createToolApprovalRequestsSelector);
  const [selectEditActivityJson] = useState(createEditActivityRunEventsSelector);

  const terminalEventsJson = useAuiState((state) =>
    selectTerminalEventsJson(state.thread.messages)
  );
  const approvalRequestsJson = useAuiState((state) =>
    selectApprovalRequestsJson(state.thread.messages)
  );
  const editActivityJson = useAuiState((state) => selectEditActivityJson(state.thread.messages));
  const isHistoryLoading = useAuiState((state) => state.thread.isLoading);

  useNewStreamValues<AssistantRunEvent>({
    isHistoryLoading,
    keyOf: (event) => event.id,
    onNew: (event) => {
      if (event.kind === 'run.finished') {
        callbacks.onRunFinished?.(event);
      } else {
        callbacks.onRunFailed?.(event);
      }
    },
    serializedValues: terminalEventsJson,
    threadKey,
  });

  useNewStreamValues<AssistantToolApprovalRequest>({
    isHistoryLoading,
    keyOf: getToolActionIdentityKey,
    onNew: (request) => {
      callbacks.onToolApprovalRequired?.(request);
    },
    serializedValues: approvalRequestsJson,
    threadKey,
  });

  useNewStreamValues<AssistantRunEvent>({
    isHistoryLoading,
    keyOf: (event) => event.id,
    onNew: (event) => {
      callbacks.onRunEditActivity?.(event);
    },
    serializedValues: editActivityJson,
    threadKey,
  });
}

/** Always-mounted, render-nothing bridge — see module doc for placement. */
export function RunLifecycleNotificationBridge(
  props: RunLifecycleNotificationCallbacks & { readonly threadKey?: string }
) {
  const { threadKey, ...callbacks } = props;
  useRunLifecycleNotifications(callbacks, threadKey);
  return null;
}
