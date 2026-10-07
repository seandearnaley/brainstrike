import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// This storage proof admits only the exact producer-owned recorded HostEvent bodies.
// Production delegates to HostEventSchema in Studio's trusted producer module.
const recorded = JSON.parse(
  readFileSync(
    new URL('../../../agent-host/__tests__/fixtures/approved-run-log.json', import.meta.url),
    'utf8'
  )
);

export function decode(raw, mode) {
  const { seq, ...event } = JSON.parse(raw);
  const valid = recorded.some((row) => isDeepStrictEqual(row.event, event));
  if (!valid) {
    if (mode === 'dev') {
      throw new Error('Unknown recorded Core event');
    }
    return { raw, reason: 'Unknown recorded Core event', seq, type: 'unreadable' };
  }
  return { seq, ...event };
}
export function text(event) {
  if (event.type === 'run.started') {
    return event.prompt;
  }
  if (event.type === 'model.step' || event.type === 'model.messages') {
    return JSON.stringify(event.messages);
  }
  // The Core producer gives recognized metadata no searchable source text.
  return null;
}
export function messages(rows) {
  return rows.flatMap(({ threadId, seq, event }) => {
    if (event.type === 'run.started') {
      const accepted = rows.find(
        (row) =>
          row.seq < seq &&
          row.event.type === 'command.accepted' &&
          row.event.method === 'run/start' &&
          row.event.result?.runId === event.runId &&
          row.event.payload?.threadId === threadId &&
          row.event.payload?.prompt === event.prompt
      );
      return accepted ? [{ messageId: accepted.event.commandId, seq }] : [];
    }
    if (event.type === 'model.step' || event.type === 'model.messages') {
      return [{ messageId: JSON.stringify([threadId, seq]), seq }];
    }
    return [];
  });
}
