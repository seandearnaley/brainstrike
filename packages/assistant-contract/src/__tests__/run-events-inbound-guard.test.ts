import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  isAssistantRunEvent,
  readAssistantRunEventDataPart,
} from '../run-events.js';

const validEvent = {
  id: 'evt-1',
  kind: 'run.finished',
  label: 'Run finished',
  status: 'completed',
  timestamp: '2026-07-31T00:00:00.000Z',
} as const;

describe('isAssistantRunEvent', () => {
  it('accepts a minimal event and a fully populated event', () => {
    expect(isAssistantRunEvent(validEvent)).toBe(true);
    expect(
      isAssistantRunEvent({
        ...validEvent,
        detail: 'done',
        durationMs: 12.5,
        metadata: { nested: { list: [1, 'two', true, null] } },
        runId: 'run-1',
        sequence: 3,
      })
    ).toBe(true);
  });

  it('rejects non-records, arrays, and missing required fields', () => {
    expect(isAssistantRunEvent(null)).toBe(false);
    expect(isAssistantRunEvent([validEvent])).toBe(false);
    for (const key of ['id', 'kind', 'label', 'status', 'timestamp'] as const) {
      const { [key]: _dropped, ...rest } = validEvent;
      expect(isAssistantRunEvent(rest)).toBe(false);
    }
  });

  it('rejects kinds and statuses outside the closed unions', () => {
    expect(isAssistantRunEvent({ ...validEvent, kind: 'run.imaginary' })).toBe(false);
    expect(isAssistantRunEvent({ ...validEvent, status: 'exploded' })).toBe(false);
  });

  it('rejects mistyped optionals, including non-finite numbers', () => {
    expect(isAssistantRunEvent({ ...validEvent, detail: 7 })).toBe(false);
    expect(isAssistantRunEvent({ ...validEvent, runId: {} })).toBe(false);
    expect(isAssistantRunEvent({ ...validEvent, durationMs: Number.NaN })).toBe(false);
    expect(isAssistantRunEvent({ ...validEvent, sequence: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('rejects array metadata and non-JSON metadata values', () => {
    expect(isAssistantRunEvent({ ...validEvent, metadata: ['not-a-record'] })).toBe(false);
    expect(isAssistantRunEvent({ ...validEvent, metadata: { bad: () => 'nope' } })).toBe(false);
    expect(isAssistantRunEvent({ ...validEvent, metadata: { ok: 'fine' } })).toBe(true);
  });

  it('rejects metadata nested beyond the sanitizer depth cap', () => {
    let nested: unknown = 'leaf';
    for (let level = 0; level < 8; level++) {
      nested = { nested };
    }
    expect(isAssistantRunEvent({ ...validEvent, metadata: { nested } })).toBe(false);

    let shallow: unknown = 'leaf';
    for (let level = 0; level < 6; level++) {
      shallow = { shallow };
    }
    expect(isAssistantRunEvent({ ...validEvent, metadata: { shallow } })).toBe(true);
  });
});

describe('readAssistantRunEventDataPart', () => {
  it('returns the event for a well-formed named data part', () => {
    expect(
      readAssistantRunEventDataPart({ data: validEvent, name: ASSISTANT_RUN_EVENT_DATA_NAME })
    ).toEqual(validEvent);
  });

  it('returns undefined for other names, non-records, and malformed events', () => {
    expect(readAssistantRunEventDataPart({ data: validEvent, name: 'other' })).toBeUndefined();
    expect(readAssistantRunEventDataPart('not-a-part')).toBeUndefined();
    expect(readAssistantRunEventDataPart(null)).toBeUndefined();
    expect(
      readAssistantRunEventDataPart({
        data: { ...validEvent, kind: 'run.imaginary' },
        name: ASSISTANT_RUN_EVENT_DATA_NAME,
      })
    ).toBeUndefined();
  });
});
