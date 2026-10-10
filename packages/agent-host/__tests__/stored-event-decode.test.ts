import approved from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import granted from '@brainstrike/test-utils/fixtures/committed-host-granted-run.json' with {
  type: 'json',
};
import hookBlocked from '@brainstrike/test-utils/fixtures/committed-host-hook-blocked.json' with {
  type: 'json',
};
import hooksSkipped from '@brainstrike/test-utils/fixtures/committed-host-hooks-skipped.json' with {
  type: 'json',
};
import mcpUnavailable from '@brainstrike/test-utils/fixtures/committed-host-mcp-unavailable.json' with {
  type: 'json',
};
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import question from '@brainstrike/test-utils/fixtures/committed-host-question.json' with {
  type: 'json',
};
import rewinds from '@brainstrike/test-utils/fixtures/committed-host-rewinds.json' with {
  type: 'json',
};
import attempts from '@brainstrike/test-utils/fixtures/committed-host-run-attempts.json' with {
  type: 'json',
};
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { expect, test } from 'vitest';
import { z } from 'zod';
import { decodeStoredHostEvent } from '../src/event-storage.js';
import { HOST_METHOD_SCHEMAS, HostEventSchema, HostLogRowSchema } from '../src/protocol.js';
import { foldHostRunAdmission, type HostRunAdmissionCommand } from '../src/run-branch.js';
import configured from './fixtures/committed-configured-run-command.json' with { type: 'json' };

const recordings = [
  approved,
  granted,
  hookBlocked,
  hooksSkipped,
  mcpUnavailable,
  plan,
  question,
  rewinds,
  attempts,
  rich,
];

/** Counts every property read and key listing of a JSON value, however deep. */
function watched(value: unknown, reads: { count: number }): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const inner = Array.isArray(value)
    ? value.map((item) => watched(item, reads))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, watched(item, reads)]));
  return new Proxy(inner, {
    get(target, key, receiver) {
      reads.count += 1;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      reads.count += 1;
      return Reflect.ownKeys(target);
    },
  });
}

test("a stored row's JSON values are accepted as JSON.parse produced them, never walked again", () => {
  const reads = { count: 0 };
  const accepted = z
    .array(HostLogRowSchema)
    .parse(approved)
    .find(
      (row) => row.event.type === 'command.accepted' && row.event.method === 'run/start'
    )?.event;
  if (accepted?.type !== 'command.accepted') {
    throw new Error('The recorded run has no run/start command');
  }
  const stored = {
    ...accepted,
    payload: watched(accepted.payload, reads),
    result: watched(accepted.result, reads),
  };
  const decoded = decodeStoredHostEvent(stored);
  // The envelope is validated; the payload and result are the stored values.
  expect(decoded).toMatchObject({ commandId: accepted.commandId, type: 'command.accepted' });
  expect(reads.count).toBe(0);
});

test('committed run admission preserves recorded configuration values without walking them again', () => {
  const reads = { count: 0 };
  const { seq: _seq, ...event } = configured.row;
  const configuration = Object.fromEntries(
    Object.entries(event.payload.configuration).map(([key, value]) => [key, watched(value, reads)])
  );
  const accepted = decodeStoredHostEvent({
    ...event,
    payload: { ...event.payload, configuration },
  });
  if (accepted.type !== 'command.accepted') {
    throw new Error('The recorded configured run has no accepted command');
  }
  const admitted = new Map<string, HostRunAdmissionCommand>();
  const conversationIds = new Set<string>();

  foldHostRunAdmission(admitted, conversationIds, accepted);

  expect(reads.count).toBe(0);
  expect(conversationIds.has(event.commandId)).toBe(true);
  const admission = admitted.get(event.result.runId);
  expect(admission).toEqual({
    commandId: event.commandId,
    input: { configuration },
    method: event.method,
  });
  for (const [key, value] of Object.entries(configuration)) {
    expect(admission?.input?.configuration?.[key]).toBe(value);
  }
});

test('producer and wire decoding still validate nested run configuration JSON', () => {
  const { seq: _seq, ...event } = configured.row;
  expect(HostEventSchema.parse(event)).toEqual(event);
  expect(HOST_METHOD_SCHEMAS['run/start'].parse(event.payload)).toEqual(event.payload);
  const { parentMessageId: _parent, prompt: _prompt, ...regenerate } = event.payload;
  const regenerateParams = { ...regenerate, userMessageId: event.commandId };
  expect(HOST_METHOD_SCHEMAS['run/regenerate'].parse(regenerateParams)).toEqual(regenerateParams);

  for (const invalid of [undefined, Number.NaN, () => null]) {
    const configuration = { ...event.payload.configuration, invalid: { nested: invalid } };
    const payload = { ...event.payload, configuration };
    expect(() => HostEventSchema.parse({ ...event, payload })).toThrow();
    expect(() => HOST_METHOD_SCHEMAS['run/start'].parse(payload)).toThrow();
    expect(() =>
      HOST_METHOD_SCHEMAS['run/regenerate'].parse({ ...regenerateParams, configuration })
    ).toThrow();
  }
});

test('committed run admission still refuses malformed configuration and result structure', () => {
  const { seq: _seq, ...event } = configured.row;
  const malformed = [
    ...[null, [], 7, { missing: undefined }].map((configuration) => ({
      ...event,
      payload: { ...event.payload, configuration },
    })),
    { ...event, payload: null },
    { ...event, result: { runId: 7 } },
    { ...event, result: {} },
  ];
  for (const stored of malformed) {
    const accepted = decodeStoredHostEvent(stored);
    if (accepted.type !== 'command.accepted') {
      throw new Error('The recorded configured run has no accepted command');
    }
    expect(() => foldHostRunAdmission(new Map(), new Set(), accepted)).toThrow();
  }
});

test('stored-row decoding equals the full producer decode on every recorded event', () => {
  for (const recording of recordings) {
    for (const row of z.array(HostLogRowSchema).parse(recording)) {
      const stored = JSON.parse(JSON.stringify(row.event)) as Record<string, unknown>;
      expect(decodeStoredHostEvent(stored)).toEqual(HostEventSchema.parse(stored));
    }
  }
});

test('stored-row decoding still refuses a row whose structure is wrong', () => {
  const accepted = z.array(HostLogRowSchema).parse(approved)[0]?.event;
  expect(() => decodeStoredHostEvent({ ...accepted, commandId: 7 })).toThrow();
  expect(() => decodeStoredHostEvent({ ...accepted, unexpected: true })).toThrow();
  const { payload: _payload, ...missing } = accepted as Record<string, unknown>;
  expect(() => decodeStoredHostEvent(missing)).toThrow();
});
