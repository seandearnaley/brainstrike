/**
 * ADR-0011: every view is a fold of the committed log, so what the host shows
 * while a thread is live is what it shows after a reopen, and what the model is
 * sent next follows the same path either way. The hydration-siblings bug broke
 * that four times before BST-1243.
 *
 * Generated conversations run through a real HostCore over a real StateStore
 * (`fixtures/host-conversation-scenario.ts`): each run's first request is
 * checked against a reference conversation tree, and each reopen's reads
 * against the closing host's. Their committed logs then feed the folds the
 * desktop and the host build views from.
 */
import fc from 'fast-check';
import { afterEach, expect, test } from 'vitest';
import { HostRunMap } from '../src/core-state.js';
import { foldHostEditCheckpoints } from '../src/edit-checkpoint-view.js';
import type { HostLogRow } from '../src/protocol.js';
import {
  foldHostRunAdmission,
  foldHostRunEvent,
  foldHostStartedRun,
  type HostRunAdmissionCommand,
  hostRunContext,
} from '../src/run-branch.js';
import { CommittedThreadView, foldHostRuns } from '../src/thread-view.js';
import { hostScenario, runHostScenario } from './fixtures/host-conversation-scenario.js';

const cleanup: (() => Promise<void>)[] = [];
async function closeAll(): Promise<void> {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
}
afterEach(closeAll);

/** Host open's run fold: admissions, starts and run events, as `HostCore.fold` applies them. */
function foldRuns(rows: readonly HostLogRow[]) {
  const runs = new HostRunMap();
  const admitted = new Map<string, HostRunAdmissionCommand>();
  const conversationIds = new Set<string>();
  for (const row of rows) {
    const { event } = row;
    if (event.type === 'command.accepted') {
      foldHostRunAdmission(admitted, conversationIds, event);
    } else if (event.type === 'run.started') {
      foldHostStartedRun(
        admitted,
        conversationIds,
        runs,
        row.threadId,
        event,
        { categories: new Set(), outsideSandbox: new Set(), tools: new Set() },
        () => false
      );
    } else {
      foldHostRunEvent(runs, event, row.ts);
    }
  }
  // What a run's next request is built from: its branch and its committed context.
  return [...runs.values()].map((run) => ({
    branch: run.branch,
    context: hostRunContext(runs, run),
    id: run.id,
    terminal: run.terminal,
  }));
}

/** Every view a client or the host folds from a thread's rows. */
function views(rows: readonly HostLogRow[]) {
  return {
    checkpoints: foldHostEditCheckpoints(rows),
    runs: foldHostRuns(rows),
    state: foldRuns(rows),
  };
}

const answer = { stopWhenAsked: false, tools: [] } as const;

/**
 * KNOWN BUG (BST-2459), found by the generated property below. `HostCore.admitRun`
 * commits a run's run.started without folding it, so `HostThreadRewinds` never
 * sees the run that consumed a rewind, and the rewind stays current while the
 * host lives. Live, the second message sent after a rewind branches from the
 * rewound head again, a sibling of the first, and the model is not sent the
 * first exchange. After a reopen the fold marks the rewind consumed, and the
 * same message follows the first. Remove `.fails` here and below, and the
 * fixture's `liveRewindTip` option, with the fix.
 */
test.fails('after a rewind, the second message at the tip follows the first, live as after a reopen', async () => {
  await runHostScenario(
    [
      { kind: 'start', parent: 'root', script: answer },
      { kind: 'rewind', message: 0 },
      { kind: 'start', parent: 'tip', script: answer },
      { kind: 'start', parent: 'tip', script: answer },
    ],
    cleanup,
    { liveRewindTip: 'exercise' }
  );
});

/** The same bug: live, the stale rewind leaves the message sent since it off the branch. */
test.fails('after a rewind, the message sent since can be rewound, live as after a reopen', async () => {
  await runHostScenario(
    [
      { kind: 'start', parent: 'root', script: answer },
      { kind: 'rewind', message: 0 },
      { kind: 'start', parent: 'tip', script: answer },
      { kind: 'rewind', message: 0 },
    ],
    cleanup,
    { liveRewindTip: 'exercise' }
  );
});

test('after a rewind and a reopen, the next message at the tip follows the latest run', async () => {
  await runHostScenario(
    [
      { kind: 'start', parent: 'root', script: answer },
      { kind: 'rewind', message: 0 },
      { kind: 'start', parent: 'tip', script: answer },
      { kind: 'reopen' },
      { kind: 'start', parent: 'tip', script: answer },
      { kind: 'rewind', message: 1 },
    ],
    cleanup,
    { liveRewindTip: 'exercise' }
  );
});

test('a generated conversation sends each run its path and reads the same before and after each reopen', async () => {
  await fc.assert(
    fc.asyncProperty(hostScenario({ maxCommands: 10 }), async (commands) => {
      try {
        const result = await runHostScenario(commands, cleanup);
        // A live subscriber received exactly the rows the reopened store reads.
        expect(result.published).toEqual(result.rows);
      } finally {
        await closeAll();
      }
    }),
    { numRuns: 60 }
  );
});

test('every prefix of a committed conversation folds, and folds the same each time', async () => {
  await fc.assert(
    fc.asyncProperty(hostScenario(), async (commands) => {
      try {
        const { rows } = await runHostScenario(commands, cleanup);
        for (let end = 0; end <= rows.length; end += 1) {
          const prefix = rows.slice(0, end);
          expect(() => views(prefix), `prefix of ${end} rows`).not.toThrow();
        }
        expect(views(rows)).toEqual(views(rows));
      } finally {
        await closeAll();
      }
    }),
    { numRuns: 20 }
  );
});

test('rows delivered live in any order, batch and overlap show the log a reopen replays', async () => {
  // Each delivery is a run of consecutive rows; replay and live may overlap or repeat.
  const deliveries = fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 8 });
  await fc.assert(
    fc.asyncProperty(hostScenario(), deliveries, async (commands, cuts) => {
      try {
        const { rows, threadId } = await runHostScenario(commands, cleanup);
        const view = new CommittedThreadView(threadId);
        for (const [a, b] of cuts) {
          const [from, to] = [a % (rows.length + 1), b % (rows.length + 1)].sort((x, y) => x - y);
          view.accept(rows.slice(from, to));
          // A view never shows a row past a gap it has not received.
          const shown = view.getSnapshot();
          expect(shown).toEqual(rows.slice(0, shown.length));
        }
        view.accept(rows);
        expect(view.getSnapshot()).toEqual(rows);
        expect(foldHostRuns(view.getSnapshot())).toEqual(foldHostRuns(rows));
      } finally {
        await closeAll();
      }
    }),
    { numRuns: 20 }
  );
});
