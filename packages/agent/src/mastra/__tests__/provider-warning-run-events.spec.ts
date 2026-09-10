/**
 * BST-1701: what a captured provider warning LOOKS like on the turn.
 *
 * The capture half is proven against the real adapter in
 * `src/__tests__/provider-call-warnings.spec.ts`; this file pins the
 * presentation half - one always-visible row per distinct warning, no row when
 * the provider had nothing to say, and a row for EVERY warning type rather
 * than only `unsupported`.
 */
import {
  ASSISTANT_RUN_EVENT_KINDS,
  MAX_RUN_EVENT_REASON_CHARS,
} from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { createProviderCallWarningSink } from '../../providers/provider-call-warnings';
import type { StreamChunk } from '../../types';
import {
  drainProviderCallWarningChunks,
  MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS,
  makeProviderCallWarningChunks,
  PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
} from '../provider-warning-run-events';

interface RunEventChunkLike {
  event: {
    detail?: string;
    kind: string;
    label: string;
    metadata?: Record<string, unknown>;
    status: string;
  };
  type: string;
}

function rows(chunks: readonly StreamChunk[]): RunEventChunkLike['event'][] {
  return chunks.map((chunk) => {
    expect((chunk as RunEventChunkLike).type).toBe('run-event');
    return (chunk as RunEventChunkLike).event;
  });
}

describe('provider warning run events', () => {
  it('declares a kind the run-event contract knows', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain(PROVIDER_CALL_WARNING_RUN_EVENT_KIND);
  });

  it('turns a dropped sampling param into one visible failed row', () => {
    const [row] = rows(
      makeProviderCallWarningChunks([
        {
          detail: 'temperature is not supported by claude-opus-5 and will be ignored',
          subject: 'temperature',
          type: 'unsupported',
        },
      ])
    );

    expect(row).toMatchObject({
      detail: 'temperature: temperature is not supported by claude-opus-5 and will be ignored',
      kind: PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
      label: 'Provider ignored an unsupported setting',
      metadata: { feature: 'temperature', warningType: 'unsupported' },
      status: 'failed',
    });
  });

  it('emits nothing when the provider reported nothing', () => {
    expect(makeProviderCallWarningChunks([])).toEqual([]);
    const sink = createProviderCallWarningSink();
    sink.record([]);
    expect([...drainProviderCallWarningChunks(sink)]).toEqual([]);
    sink.record(undefined);
    expect([...drainProviderCallWarningChunks(sink)]).toEqual([]);
  });

  it.each([
    ['compatibility', 'Provider used a compatibility mode'],
    ['deprecated', 'Provider reported a deprecated setting'],
    ['other', 'Provider reported a warning'],
    ['unrecognized', 'Provider reported a warning'],
    // Not in the label table at all: a type this build has never seen still
    // gets a row. A consumer that filtered to `unsupported` would go dark here.
    ['clamped', 'Provider reported a warning'],
  ])('surfaces a %s warning too', (type, label) => {
    const [row] = rows(
      makeProviderCallWarningChunks([{ detail: 'something happened', subject: 'topP', type }])
    );
    expect(row).toMatchObject({
      detail: 'topP: something happened',
      kind: PROVIDER_CALL_WARNING_RUN_EVENT_KIND,
      label,
      metadata: { feature: 'topP', warningType: type },
      status: 'failed',
    });
  });

  it('still says something true when the warning carries no text at all', () => {
    const [row] = rows(makeProviderCallWarningChunks([{ type: 'other' }]));
    expect(row?.detail).toBe(
      'The provider reported a "other" warning about this request without any detail.'
    );
    expect(row?.metadata).toEqual({ warningType: 'other' });
  });

  it('bounds a runaway provider message', () => {
    const [row] = rows(
      makeProviderCallWarningChunks([{ detail: 'x'.repeat(5000), type: 'other' }])
    );
    expect(row?.detail?.length).toBeLessThanOrEqual(MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS);
  });

  it('identifies the warning model in visible detail and persisted metadata', () => {
    const [row] = rows(
      makeProviderCallWarningChunks([
        {
          origin: { modelId: 'gpt-5.6-sol', provider: 'openai' },
          subject: 'temperature',
          type: 'unsupported',
        },
      ])
    );
    expect(row?.detail).toBe('openai/gpt-5.6-sol: temperature');
    expect(row?.metadata).toEqual({
      feature: 'temperature',
      modelId: 'gpt-5.6-sol',
      provider: 'openai',
      warningType: 'unsupported',
    });
  });

  it('bounds no-detail warning prose and all provider-controlled metadata values', () => {
    const [withoutDetail, withFeature] = rows(
      makeProviderCallWarningChunks([
        { type: 't'.repeat(5000) },
        { subject: 'f'.repeat(5000), type: 't'.repeat(5000) },
      ])
    );
    expect(withoutDetail?.detail?.length).toBeLessThanOrEqual(
      MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS
    );
    for (const row of [withoutDetail, withFeature]) {
      for (const value of Object.values(row?.metadata ?? {})) {
        expect(typeof value).toBe('string');
        expect(Array.from(String(value))).toHaveLength(MAX_RUN_EVENT_REASON_CHARS);
      }
    }
  });

  it('mints one row per distinct warning and gives every row its own id', () => {
    const sink = createProviderCallWarningSink();
    sink.record([
      { feature: 'temperature', type: 'unsupported' },
      { feature: 'topP', type: 'unsupported' },
    ]);
    const chunks = [...drainProviderCallWarningChunks(sink)];
    expect(chunks).toHaveLength(2);
    const ids = chunks.map((chunk) => (chunk as unknown as { event: { id: string } }).event.id);
    expect(new Set(ids).size).toBe(2);
    // Drained: the same turn must not repeat the rows on its next part.
    expect([...drainProviderCallWarningChunks(sink)]).toEqual([]);
  });

  it('emits nothing for a run with no sink (a descriptor-configured provider)', () => {
    expect([...drainProviderCallWarningChunks(undefined)]).toEqual([]);
  });
});
