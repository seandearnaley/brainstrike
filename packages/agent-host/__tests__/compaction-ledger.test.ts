/**
 * BST-2527: the person's own requests of the turns a compaction covers, as the
 * host writes them into the note.
 */
import { describe, expect, it } from 'vitest';
import { compactedRequests } from '../src/compaction-ledger.ts';
import type { HostRunBranch, HostRunState } from '../src/core-state.ts';

function run(id: string, prompt: string, author: HostRunBranch['author'] = 'person') {
  return {
    branch: { author, parentMessageId: null, prompt, userMessageId: `user-${id}` },
    id,
    stepEnds: new Map(),
  } as HostRunState;
}

describe('compactedRequests', () => {
  it('keeps each wholly compacted turn’s request word for word, oldest first', () => {
    const chain = [
      run('run-0', 'Move the port to 8443.\n\nKeep  the old default in a comment.'),
      run('run-1', 'Then write the release notes.'),
      run('run-2', 'Still in the request.'),
    ];
    expect(compactedRequests(chain, new Set(['run-1', 'run-0']))).toEqual([
      'Move the port to 8443.\n\nKeep  the old default in a comment.',
      'Then write the release notes.',
    ]);
  });

  it('cuts a request at 1,000 characters with a marker, never inside a character', () => {
    const long = `${'a'.repeat(999)}😀${'b'.repeat(500)}`;
    expect(
      compactedRequests(
        [run('run-0', long), run('run-1', 'a'.repeat(1000))],
        new Set(['run-0', 'run-1'])
      )
    ).toEqual([`${'a'.repeat(999)}😀 [truncated]`, 'a'.repeat(1000)]);
  });

  it('keeps the newest requests whose total stays within 4,000 characters', () => {
    const chain = Array.from({ length: 6 }, (_, index) =>
      run(`run-${index}`, `${index}`.repeat(1000))
    );
    expect(compactedRequests(chain, new Set(chain.map(({ id }) => id)))).toEqual(
      ['2', '3', '4', '5'].map((digit) => digit.repeat(1000))
    );
  });

  it('lists only the person’s words: never a delegation’s task, a wake’s delivery or a host continuation', () => {
    const chain = [
      run('run-0', 'Review the module.', 'agent'),
      run('run-1', 'Your workers reported back.', 'host'),
      run('run-2', 'Ship it.'),
      run('run-3', ''),
    ];
    expect(compactedRequests(chain, new Set(chain.map(({ id }) => id)))).toEqual(['Ship it.']);
  });
});
