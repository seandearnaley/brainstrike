import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  isAssistantRunEvent,
  readAssistantRunEvent,
  readAssistantRunEventDataPart,
  sanitizeAssistantRunEventMetadata,
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

  it('rejects retired context event kinds that never had production emitters', () => {
    for (const kind of ['context.budget', 'context.prepared', 'context.selection']) {
      expect(isAssistantRunEvent({ ...validEvent, kind })).toBe(false);
    }
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

  it('shares the sanitizer depth boundary exactly: past-cap slots may only hold null', () => {
    const wrap = (leaf: unknown, levels: number): unknown => {
      let nested = leaf;
      for (let level = 0; level < levels; level++) {
        nested = { nested };
      }
      return nested;
    };
    // metadata sits at depth 0 and `deep` at depth 1, so 8 wrappers put the
    // leaf one level PAST the cap (depth 9): only the sanitizer's null
    // replacement is valid there.
    expect(isAssistantRunEvent({ ...validEvent, metadata: { deep: wrap('leaf', 8) } })).toBe(false);
    expect(isAssistantRunEvent({ ...validEvent, metadata: { deep: wrap(null, 8) } })).toBe(true);
    // 7 wrappers keep the leaf AT the cap (depth 8): any scalar is valid.
    expect(isAssistantRunEvent({ ...validEvent, metadata: { deep: wrap('leaf', 7) } })).toBe(true);
  });

  it('round-trip: whatever the outbound sanitizer emits passes the inbound guard', () => {
    const pathological: Record<string, unknown> = {
      absent: undefined,
      deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 'way past the cap' } } } } } } } } },
      fn: () => 'stripped',
      nan: Number.NaN,
      ok: ['fine', { nested: true }],
    };
    const sanitized = sanitizeAssistantRunEventMetadata(pathological);
    // Both the publication host and storage boundary sanitize independently.
    expect(sanitizeAssistantRunEventMetadata(sanitized)).toStrictEqual(sanitized);
    expect(JSON.parse(JSON.stringify(sanitized))).toStrictEqual(sanitized);
    expect(isAssistantRunEvent({ ...validEvent, metadata: sanitized })).toBe(true);
  });
});

describe('readAssistantRunEvent', () => {
  it('mirrors the outbound degrade-not-drop policy for metadata-only defects', () => {
    const degraded = readAssistantRunEvent({ ...validEvent, metadata: ['not-a-record'] });
    expect(degraded).toBeDefined();
    expect(degraded?.id).toBe(validEvent.id);
    expect(degraded && 'metadata' in degraded).toBe(false);

    const intact = readAssistantRunEvent({ ...validEvent, metadata: { ok: true } });
    expect(intact?.metadata).toEqual({ ok: true });
  });

  it('still drops events with core-field defects', () => {
    expect(readAssistantRunEvent({ ...validEvent, kind: 'run.imaginary' })).toBeUndefined();
    expect(readAssistantRunEvent(null)).toBeUndefined();
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

  it('degrades metadata-only defects instead of dropping the part', () => {
    const event = readAssistantRunEventDataPart({
      data: { ...validEvent, metadata: { bad: () => 'nope' } },
      name: ASSISTANT_RUN_EVENT_DATA_NAME,
    });
    expect(event?.id).toBe(validEvent.id);
    expect(event && 'metadata' in event).toBe(false);
  });
});
