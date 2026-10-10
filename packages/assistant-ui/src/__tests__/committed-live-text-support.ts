/**
 * The recorded run's live text for the browser suites: the same run's
 * `run/telemetry`, recorded beside its committed rows. The model's text
 * stream is never committed (ADR-0011 amendment), so a view receives it here.
 */
// The same run's live `run/telemetry`, recorded beside its rows.
import liveTextRecording from '@brainstrike/test-utils/fixtures/committed-approved-host-run-telemetry.json';
import type { CommittedAssistantLogStore } from '../committed-assistant-log-store';
import {
  answerStepLength,
  committedRows,
  type RecordedCommittedSource,
  recordedRunId,
  TEXT_KINDS,
  type TextKind,
} from './committed-assistant-browser-support';

interface RecordedTelemetry {
  readonly chunk: { readonly type: string } & Readonly<Record<string, unknown>>;
  readonly runId: string;
}
const recordedLiveText: readonly RecordedTelemetry[] = liveTextRecording;
/** The answer step's recorded live text, one chunk per kind, in recorded order. */
export const TEXT_TELEMETRY: Readonly<Record<TextKind, RecordedTelemetry>> = (() => {
  const [start, delta, end] = recordedLiveText;
  if (
    !(start && delta && end) ||
    recordedLiveText.length !== TEXT_KINDS.length ||
    recordedLiveText.some(({ runId }) => runId !== recordedRunId)
  ) {
    throw new Error("The recorded telemetry is not the recorded run's one text stream.");
  }
  const byKind = { 'text-delta': delta, 'text-end': end, 'text-start': start };
  for (const kind of TEXT_KINDS) {
    if (byKind[kind].chunk.type !== kind) {
      throw new Error(`The recorded telemetry has no ${kind} chunk in order.`);
    }
  }
  return byKind;
})();

/** Deliver one recorded text chunk as the live view receives it: uncommitted telemetry. */
export function publishLiveText(store: CommittedAssistantLogStore, kind: TextKind): void {
  const { chunk, runId } = TEXT_TELEMETRY[kind];
  store.acceptTelemetry(runId, chunk);
}

/**
 * After the answer step opens: its recorded live text (start, token, end),
 * then each committed row that follows (the step's text, step/run finish).
 */
export const TEXT_PUBLICATIONS: readonly {
  readonly label: string;
  readonly publish: (source: RecordedCommittedSource, store: CommittedAssistantLogStore) => void;
}[] = [
  ...TEXT_KINDS.map((kind) => ({
    label: `live ${kind}`,
    publish: (_source: RecordedCommittedSource, store: CommittedAssistantLogStore) =>
      publishLiveText(store, kind),
  })),
  ...committedRows.slice(answerStepLength).map((_, offset) => ({
    label: `committed row ${answerStepLength + offset + 1}`,
    publish: (source: RecordedCommittedSource) =>
      source.publishPrefix(answerStepLength + offset + 1),
  })),
];
