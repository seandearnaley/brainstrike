import { isDeepStrictEqual } from 'node:util';
import type { StateMessageEvent } from '@brainstrike/indexer';
import recorded from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import type { StateMessageSource } from '../../src/contracts.ts';

// This storage proof admits only the exact producer-owned recorded HostEvent bodies.
// Production delegates to HostEventSchema in Studio's trusted producer module.

type CoreEvent = Readonly<Record<string, unknown>>;

function isCoreEvent(value: unknown): value is CoreEvent {
  return typeof value === 'object' && value !== null;
}

/** The named field of a recorded event body, or undefined when the body has none. */
function field(value: unknown, key: string): unknown {
  return isCoreEvent(value) ? value[key] : undefined;
}

export function decode(raw: string, mode: 'dev' | 'prod'): CoreEvent {
  const parsed: unknown = JSON.parse(raw);
  if (!isCoreEvent(parsed)) {
    throw new TypeError('Committed Core row must be an object');
  }
  const { seq, ...event } = parsed;
  const valid = recorded.some((row) => isDeepStrictEqual(row.event, event));
  if (!valid) {
    if (mode === 'dev') {
      throw new Error('Unknown recorded Core event');
    }
    return { raw, reason: 'Unknown recorded Core event', seq, type: 'unreadable' };
  }
  return { seq, ...event };
}
export function text(event: CoreEvent): unknown {
  if (event['type'] === 'run.started') {
    return event['prompt'];
  }
  if (event['type'] === 'model.step' || event['type'] === 'model.messages') {
    return JSON.stringify(event['messages']);
  }
  // The Core producer gives recognized metadata no searchable source text.
  return null;
}
export function messages(rows: readonly StateMessageEvent[]): StateMessageSource[] {
  return rows.flatMap(({ threadId, seq, event }): StateMessageSource[] => {
    const type = field(event, 'type');
    if (type === 'run.started') {
      const accepted = rows.find(
        (row) =>
          row.seq < seq &&
          field(row.event, 'type') === 'command.accepted' &&
          field(row.event, 'method') === 'run/start' &&
          field(field(row.event, 'result'), 'runId') === field(event, 'runId') &&
          field(field(row.event, 'payload'), 'threadId') === threadId &&
          field(field(row.event, 'payload'), 'prompt') === field(event, 'prompt')
      );
      if (!accepted) {
        return [];
      }
      const messageId = field(accepted.event, 'commandId');
      if (typeof messageId !== 'string') {
        throw new TypeError('Accepted run/start command has no command id');
      }
      return [{ messageId, seq, sources: [seq, accepted.seq] }];
    }
    if (type === 'model.step' || type === 'model.messages') {
      return [{ messageId: JSON.stringify([threadId, seq]), seq, sources: [seq] }];
    }
    return [];
  });
}
