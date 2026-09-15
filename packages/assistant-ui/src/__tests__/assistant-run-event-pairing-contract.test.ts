/**
 * The run-event KIND-PAIRING contract: which terminal kind closes out which
 * running row, for both the suffix-derived `.started` pairings and the explicit
 * lists non-`.started` kinds must declare.
 *
 * Split out of `assistant-run-timeline.test.tsx`, which covers derivation and
 * rendering. These suites are pure table-driven checks over
 * `ASSISTANT_RUN_EVENT_KINDS` and the pairing helpers — no DOM, no render — and
 * they GROW every time the contract gains a kind, which is what pushed the
 * combined file past the 1000-line cap. Keeping them here means a new event
 * kind is classified in a file that is only about classification.
 */
import type { AssistantRunEventKind } from '@brainstrike/assistant-contract';
import { ASSISTANT_RUN_EVENT_KINDS } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  getMatchingCompletedKind,
  getMatchingFailedKind,
  getTerminalKinds,
} from '../assistant-run-event-derivation';

describe('getMatchingCompletedKind', () => {
  it('maps run.step.started to run.step.finished (not .completed)', () => {
    expect(getMatchingCompletedKind('run.step.started')).toBe('run.step.finished');
  });
  it('keeps run.started -> run.finished and tool.started -> tool.completed', () => {
    expect(getMatchingCompletedKind('run.started')).toBe('run.finished');
    expect(getMatchingCompletedKind('tool.started')).toBe('tool.completed');
  });
  it('maps non-run *.started to *.completed', () => {
    expect(getMatchingCompletedKind('memory.semantic.started')).toBe('memory.semantic.completed');
  });
});

describe('run-event terminal pairing contract', () => {
  const STARTED_KINDS = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.endsWith('.started'));
  const declares = (kind: string): kind is AssistantRunEventKind =>
    (ASSISTANT_RUN_EVENT_KINDS as readonly string[]).includes(kind);
  const stemOf = (kind: string) => kind.slice(0, -'.started'.length);

  // The pairing the helpers MUST produce, written out so a rename on either
  // side (contract kind or helper) fails here instead of drifting silently.
  // `subagent.started` is the case that regressed: its terminals are
  // `.finished`/`.failed`, never the `.completed` a suffix rewrite invents.
  const PAIRINGS = [
    ['memory.observation.started', 'memory.observation.completed', 'memory.observation.failed'],
    ['memory.reflection.started', 'memory.reflection.completed', null],
    ['memory.semantic.started', 'memory.semantic.completed', null],
    ['run.started', 'run.finished', 'run.failed'],
    ['run.step.started', 'run.step.finished', null],
    ['subagent.started', 'subagent.finished', 'subagent.failed'],
    ['subagent.tool.started', 'subagent.tool.completed', 'subagent.tool.failed'],
    ['tool.started', 'tool.completed', 'tool.failed'],
  ] as const;

  it('tables exactly the .started kinds the contract declares', () => {
    // Exhaustive, not a floor: a new declared `.started` kind fails HERE with
    // "add me to the table" rather than being covered only by the generic
    // loops below, which would let the table quietly stop being the full map
    // it advertises. Also catches a silently narrowed STARTED_KINDS filter.
    expect([...STARTED_KINDS].sort()).toEqual(PAIRINGS.map(([started]) => started).sort());
  });

  it.each(PAIRINGS)('pairs %s with %s / %s', (started, completed, failed) => {
    expect(getMatchingCompletedKind(started)).toBe(completed);
    expect(getMatchingFailedKind(started)).toBe(failed);
  });

  it('never pairs a .started kind with a terminal the contract does not declare', () => {
    for (const started of STARTED_KINDS) {
      const completed = getMatchingCompletedKind(started);
      const failed = getMatchingFailedKind(started);
      // A success terminal is mandatory: without one, a running row can only be
      // closed by the generic end-of-run fallbacks (or, when the failure
      // pairing is also absent, not at all — it spins for the whole run).
      expect(completed).not.toBeNull();
      expect(declares(completed as string)).toBe(true);
      if (failed !== null) {
        expect(declares(failed)).toBe(true);
      }
    }
  });

  it('pairs a failure terminal exactly when the contract declares one', () => {
    for (const started of STARTED_KINDS) {
      expect(getMatchingFailedKind(started) === null).toBe(!declares(`${stemOf(started)}.failed`));
    }
  });

  it('leaves no .started kind with an ambiguous success terminal', () => {
    // Both spellings are tried, so a namespace declaring `.completed` AND
    // `.finished` would make the lookup order load-bearing. None may.
    for (const started of STARTED_KINDS) {
      const stem = stemOf(started);
      expect([declares(`${stem}.completed`), declares(`${stem}.finished`)]).not.toEqual([
        true,
        true,
      ]);
    }
  });

  it('returns null for kinds that are not .started', () => {
    for (const kind of ASSISTANT_RUN_EVENT_KINDS.filter((k) => !k.endsWith('.started'))) {
      expect(getMatchingCompletedKind(kind)).toBeNull();
      expect(getMatchingFailedKind(kind)).toBeNull();
    }
  });
});

describe('explicit terminal pairing contract (non-.started kinds)', () => {
  const NON_STARTED_KINDS = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => !kind.endsWith('.started'));
  const declares = (kind: string): kind is AssistantRunEventKind =>
    (ASSISTANT_RUN_EVENT_KINDS as readonly string[]).includes(kind);

  // A kind that is emitted with `status: 'running'` but is NOT a `.started` kind
  // gets NOTHING from the suffix pairing, so it needs an explicit terminal list
  // or its row spins for the whole thread. Splitting every declared non-started
  // kind across these two tables forces a future kind to be classified HERE
  // instead of quietly inheriting "no terminal, spins forever".
  // LIMIT of this guard: it forces every kind to be CLASSIFIED, but it cannot
  // check the classification — the contract carries no status, so a kind that is
  // actually emitted as `running` and filed under NEVER_RUNNING passes silently.
  // Verify by hand against the emitters: `rg "makeRunEventChunk\(\s*'<kind>'" packages/agent/src`
  // and check the status argument.
  const RUNNING_WITH_EXPLICIT_TERMINALS = [
    ['tool.approval.requested', ['tool.completed', 'tool.failed', 'tool.resume.unsupported']],
  ] as const;
  const NEVER_RUNNING = [
    // BST-1737's swallowed-compaction breadcrumb. Emitted `status: 'failed'`
    // (`compactionFailureChunk` in
    // packages/assistant-service/src/stream-init-compaction.ts), never
    // `'running'`: the pass has already finished — by throwing — when the row is
    // minted, so there is no span to close out. A standalone breadcrumb that
    // stays VISIBLE rather than paired; pinned by 'forces a swallowed
    // compaction failure to stay visible (BST-1737)' in
    // assistant-run-timeline.test.tsx and by the emitter's own status
    // assertion in stream-init-compaction.test.ts.
    'compaction.failed',
    // A child's durable budget forced its reserved summary. Emitted `status:
    // 'info'` by the delegated stream projection (`projectSynthesisOutcome`),
    // never `'running'`: a standalone breadcrumb, no span, no pair.
    'delegation.budget.exhausted',
    'hook.blocked',
    'hook.notice',
    'memory.configured',
    'memory.history.loaded',
    'memory.observation.completed',
    'memory.observation.failed',
    'memory.reflection.completed',
    'memory.semantic.completed',
    'memory.working.loaded',
    'memory.working.updated',
    // BST-1602's MCP discovery skip. Emitted `status: 'failed'`
    // (`makeMcpDiscoverySkipChunks` in
    // packages/agent/src/mastra/mcp-discovery-diagnostics.ts), never
    // `'running'`: the server contributed zero tools and nothing is in flight,
    // so there is no span to close out. A standalone breadcrumb that stays
    // VISIBLE rather than paired — pinned by 'forces a skipped MCP server to
    // stay visible (BST-1602)' in assistant-run-timeline.test.tsx.
    'mcp.tools.unavailable',
    // The resolved permission gate (debug pack, 2026-09-15). Emitted `status:
    // 'completed'` (`makePermissionGateResolvedChunks` in
    // packages/agent/src/mastra/permission-gate-run-events.ts), never
    // `'running'`: the gate has already decided when the row is minted. The
    // emitted status is asserted by permission-gate-run-events.spec.ts.
    'permission.gate.resolved',
    // BST-1391's forge PR events. `use-forge-run-events.ts` emits these with
    // `status: 'info' | 'completed' | 'failed'` (see `describe()`), NEVER
    // `'running'` — a PR observation is a standalone breadcrumb appended out
    // of band from main, not a span with a start/stop pair to close out.
    'pr.checks',
    'pr.merged',
    'pr.opened',
    // BST-1701's provider call warning. Emitted `status: 'failed'`
    // (`makeProviderCallWarningChunks` in
    // packages/agent/src/mastra/provider-warning-run-events.ts), never
    // `'running'`: by the time the adapter reports what it dropped, the
    // decision is already made and nothing is in flight. A standalone
    // breadcrumb that stays VISIBLE rather than paired - pinned by 'forces a
    // dropped provider setting to stay visible (BST-1701)' in
    // assistant-run-timeline.test.tsx.
    'provider.request.warned',
    'run.cancelled',
    // BST-1345's saturation-retry breadcrumb: `run-critical-database.ts` emits
    // it with `status: 'info'` (one retry notice), never `'running'`.
    'run.database.retried',
    'run.failed',
    'run.finished',
    // BST-1409's recovery pair. Both are emitted `status: 'info'`, never
    // `running` (`makeRunDetailEventChunk('run.stalled'|'run.resumed', 'info', …)`
    // in packages/agent/src/mastra/agent-streaming.ts), so neither needs a
    // terminal of its own — they are standalone breadcrumbs, not spans. They
    // stay VISIBLE rather than paired; that is pinned separately by
    // 'keeps run.stalled and run.resumed visible in the timeline' below.
    'run.resumed',
    'run.stalled',
    'run.steered',
    'run.step.finished',
    'subagent.failed',
    'subagent.finished',
    'subagent.tool.completed',
    'subagent.tool.failed',
    'tool.completed',
    'tool.failed',
    'tool.resume.unsupported',
    // BST-1390's worktree lifecycle. All three are emitted `status: 'info'`
    // (`worktree.setup` uses `'failed'` when setup failed) — never `running` —
    // so none needs a terminal of its own.
    'worktree.archived',
    'worktree.created',
    'worktree.setup',
  ] as const;
  // A kind emitted `status: 'running'` that is closed by a LATER ROW OF ITS
  // OWN KIND (same `metadata.ledgerId`), which the render plan shows in its
  // place — no terminal list: the newest row carries its own status.
  const SELF_SUPERSEDING = ['delegation.ledger'] as const;

  it('tables exactly the non-.started kinds the contract declares', () => {
    expect([...NON_STARTED_KINDS].sort()).toEqual(
      [
        ...RUNNING_WITH_EXPLICIT_TERMINALS.map(([kind]) => kind),
        ...NEVER_RUNNING,
        ...SELF_SUPERSEDING,
      ].sort()
    );
  });

  it('gives a self-superseding kind no terminal list; the newest row carries its own status', () => {
    for (const kind of SELF_SUPERSEDING) {
      expect(getTerminalKinds(kind)).toEqual([]);
    }
  });

  it.each(RUNNING_WITH_EXPLICIT_TERMINALS)(
    'closes %s out on its explicit terminals',
    (kind, terminals) => {
      expect(getTerminalKinds(kind)).toEqual(terminals);
      // Same rule as the `.started` pairing: a terminal only counts when the
      // contract declares it, so this can never name a kind nothing emits.
      for (const terminal of terminals) {
        expect(declares(terminal)).toBe(true);
      }
      // A `running` terminal would "resolve" the row to the status it already had.
      expect(terminals).not.toContain('tool.started');
    }
  );

  it('gives no never-running kind a terminal list of its own', () => {
    for (const kind of NEVER_RUNNING) {
      expect(getTerminalKinds(kind)).toEqual([]);
    }
  });
});
