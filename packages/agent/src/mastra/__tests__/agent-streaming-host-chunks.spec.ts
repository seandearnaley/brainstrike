import { describe, expect, it } from 'vitest';
import { processMastraStreamPart } from '../agent-streaming';
import { makeBackgroundLedgerChunk } from '../background-ledger';
import { createTurnAttemptLifecycleState } from '../turn-attempts';

describe('host-published run-event chunks', () => {
  it('passes a delegation.ledger row published into the leg through unchanged', async () => {
    const chunk = makeBackgroundLedgerChunk(
      { counts: { cancelled: 0, failed: 0, returned: 1, running: 1, total: 2 }, entries: [] },
      'root-run'
    );
    const result = await processMastraStreamPart(
      chunk,
      new Map(),
      createTurnAttemptLifecycleState(undefined, undefined, undefined)
    );
    expect(result).toEqual({ chunks: [chunk], finished: false });
  });

  it('refuses a malformed host run-event rather than forwarding it', async () => {
    await expect(
      processMastraStreamPart(
        { event: { kind: 'not-a-kind' }, type: 'run-event' },
        new Map(),
        createTurnAttemptLifecycleState(undefined, undefined, undefined)
      )
    ).rejects.toThrow('A host run-event chunk is malformed.');
  });
});
