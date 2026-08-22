import { describe, expect, it } from 'vitest';
import { ASSISTANT_RUN_EVENT_KINDS } from '../run-events.js';

describe('ASSISTANT_RUN_EVENT_KINDS', () => {
  it('declares every kind exactly once', () => {
    expect(new Set(ASSISTANT_RUN_EVENT_KINDS).size).toBe(ASSISTANT_RUN_EVENT_KINDS.length);
  });

  it('declares the durable approval-pause kind (BST-1402)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('tool.approval.requested');
  });

  it('declares NO resolution counterpart for the approval pause', () => {
    // By design: the pause closes out on the SAME toolCallId's next `tool.*`
    // outcome (approve => `tool.completed`, decline => `tool.failed`,
    // unanswerable => `tool.resume.unsupported`) or on the run leaving
    // `running`. A dedicated `.resolved`/`.answered` kind would be a second
    // source of truth for a fact the existing terminals already carry.
    const forbidden = ['tool.approval.resolved', 'tool.approval.answered', 'tool.approval.denied'];
    for (const kind of forbidden) {
      expect(ASSISTANT_RUN_EVENT_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it('keeps the approval pause OUT of the `.started` lifecycle namespace', () => {
    // `collectToolDurations` and the timeline's suffix pairing both key off
    // `.started`. A `tool.approval.started` spelling would time the USER's
    // deliberation as tool execution and pair against `tool.completed` as if a
    // tool had run.
    const startedKinds = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.endsWith('.started'));
    expect(startedKinds).not.toContain('tool.approval.requested');
    // And `.started` really is the lifecycle namespace it is being kept out of:
    // every kind in it declares the success terminal the suffix pairing derives.
    // (A pause has no such terminal — it is answered by an unrelated call's
    // outcome — which is exactly why it is not spelled `.started`.)
    for (const started of startedKinds) {
      const stem = started.slice(0, -'.started'.length);
      const terminals = (ASSISTANT_RUN_EVENT_KINDS as readonly string[]).filter(
        (kind) => kind === `${stem}.completed` || kind === `${stem}.finished`
      );
      expect(terminals).toHaveLength(1);
    }
  });
});
