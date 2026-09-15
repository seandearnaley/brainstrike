import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_RUN_EVENT_KINDS,
  boundRunEventReason,
  MAX_RUN_EVENT_REASON_CHARS,
  redactRunEventReason,
} from '../run-events.js';

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

  it('declares the three worktree lifecycle kinds (BST-1390)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('worktree.archived');
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('worktree.created');
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('worktree.setup');
  });

  it('keeps the worktree kinds OUT of the `.started` lifecycle namespace', () => {
    // They are standalone breadcrumbs — a worktree create is atomic from the
    // timeline's point of view, so a `.started` spelling would demand a
    // terminal the operation never emits and the row would spin forever.
    const worktreeKinds = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.startsWith('worktree.'));
    expect(worktreeKinds.some((kind) => kind.endsWith('.started'))).toBe(false);
  });

  it('declares the swallowed-compaction breadcrumb kind (BST-1737)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('compaction.failed');
  });

  it('declares NO `.started` or success counterpart for the compaction breadcrumb', () => {
    // A standalone breadcrumb for a pass that ALREADY finished (by throwing):
    // nothing is in flight, so it declares no terminal and must never be paired
    // against one. A `compaction.started` spelling would additionally make the
    // suffix pairing derive `compaction.failed` as its terminal and leave the
    // row spinning on every turn compaction succeeds.
    const compactionKinds = ASSISTANT_RUN_EVENT_KINDS.filter((kind) =>
      kind.startsWith('compaction.')
    );
    expect(compactionKinds).toEqual(['compaction.failed']);
  });

  it('declares the MCP discovery skip kind (BST-1602)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('mcp.tools.unavailable');
  });

  it('keeps the MCP discovery skip kind OUT of the `.started` lifecycle namespace', () => {
    // A standalone breadcrumb: no tool ran and no phase began, so it declares
    // no terminal and must never be paired against one.
    const mcpKinds = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.startsWith('mcp.'));
    expect(mcpKinds).toEqual(['mcp.tools.unavailable']);
    expect(mcpKinds.some((kind) => kind.endsWith('.started'))).toBe(false);
  });

  it('declares the provider call-warning kind (BST-1701)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('provider.request.warned');
  });

  it('keeps the provider call-warning kind OUT of the `.started` lifecycle namespace', () => {
    // Another standalone breadcrumb. The provider has already decided what it
    // would not honor by the time the row exists, so nothing is in flight and
    // there is no terminal to pair against.
    const providerKinds = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.startsWith('provider.'));
    expect(providerKinds).toEqual(['provider.request.warned']);
    expect(providerKinds.some((kind) => kind.endsWith('.started'))).toBe(false);
  });

  it('declares the delegation ledger kind (settled 2026-09-15)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('delegation.ledger');
  });

  it('keeps the delegation ledger OUT of the `.started` lifecycle namespace', () => {
    // A self-superseding row: every change emits a fresh row for the same
    // `metadata.ledgerId`; the renderer shows the latest. No pair to close.
    // The budget breadcrumb is likewise standalone (see below).
    const kinds = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.startsWith('delegation.'));
    expect(kinds).toEqual(['delegation.budget.exhausted', 'delegation.ledger']);
  });

  it('declares the budget-exhaustion breadcrumb with no lifecycle pair', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('delegation.budget.exhausted');
    expect(ASSISTANT_RUN_EVENT_KINDS as readonly string[]).not.toContain(
      'delegation.budget.started'
    );
  });
});

describe('boundRunEventReason', () => {
  // Promoted here from packages/agent's `boundMcpDiscoveryReason` by BST-1737
  // so compaction failures and MCP discovery skips share ONE redaction
  // implementation. packages/agent's mcp-discovery-run-events.spec.ts still
  // exercises the same function through that alias.
  it('redacts an api key carried in a URL query string', () => {
    const reason = boundRunEventReason(
      new Error('fetch failed: 401 for https://example.test/mcp?api_key=sk-live-secret')
    );
    expect(reason).not.toContain('sk-live-secret');
    expect(reason).toContain('[redacted]');
  });

  it('redacts credentials carried in URL userinfo', () => {
    const reason = boundRunEventReason(new Error('connect https://alice:hunter2@host/mcp'));
    expect(reason).not.toContain('hunter2');
    expect(reason).toContain('[redacted]');
  });

  it.each([
    ['postgres://bruce:hunter2@db.internal:5432/brainstrike', 'hunter2', 'db.internal'],
    ['postgresql://bruce:hunter2@db.internal/brainstrike', 'hunter2', 'brainstrike'],
    ['redis://default:hunter2@cache.internal:6379', 'hunter2', 'cache.internal'],
    ['mongodb+srv://bruce:hunter2@cluster.example.net', 'hunter2', 'cluster.example.net'],
  ])('redacts non-HTTP userinfo in %s', (uri, secret, survives) => {
    // BST-1737 widened this helper's input from MCP transport errors (always
    // HTTP) to memory-store and DB failures, which quote driver URIs. A
    // scheme-restricted pattern would let those through into durable metadata
    // and an always-visible row.
    const reason = boundRunEventReason(new Error(`compaction store read failed: ${uri}`));
    expect(reason).not.toContain(secret);
    expect(reason).toContain('[redacted]');
    // The host has to SURVIVE: without this the same assertions would pass on a
    // pattern that over-matched and swallowed the whole message.
    expect(reason).toContain(survives);
  });

  it('redacts a credential carried in a non-HTTP query string', () => {
    const reason = boundRunEventReason(
      new Error('connect failed postgres://db.internal/brainstrike?sslpassword=hunter2')
    );
    expect(reason).not.toContain('hunter2');
    expect(reason).toContain('[redacted]');
  });

  it('leaves an ordinary compaction failure message intact', () => {
    expect(boundRunEventReason(new Error('Unknown compaction input budget for ollama/x.'))).toBe(
      'Unknown compaction input budget for ollama/x.'
    );
  });

  it.each([
    'Unknown compaction input budget for openrouter/moonshotai/kimi-k3.',
    'compaction summary write failed at C:\\Users\\bruce\\brainstrike\\store.db',
    'compaction candidate m-1 has no valid creation time: 2026-09-10T18:46:26Z',
    'compaction store read failed in node:internal/streams/readable',
  ])('leaves scheme-SHAPED prose without :// intact: %s', (message) => {
    // The widened scheme class must still require `://`. Colons, slash runs and
    // Windows paths are ordinary content in these messages, and the four
    // redaction cases above would pass just as happily against a pattern that
    // ate them — this is the half of the property they cannot pin.
    expect(boundRunEventReason(new Error(message))).toBe(message);
  });

  it('bounds by CODE POINT so a surrogate pair is never split', () => {
    const reason = boundRunEventReason(new Error('\u{1F600}'.repeat(300)));
    expect(Array.from(reason)).toHaveLength(MAX_RUN_EVENT_REASON_CHARS);
    expect(reason.endsWith('\u2026')).toBe(true);
  });
});

describe('redactRunEventReason', () => {
  // BST-1744 split job 1 out so the compaction-failure latch key can redact the
  // UNTRUNCATED message. The property that earns the split is the one thing
  // this does NOT do — bound — and the fact that the row's bounded form and the
  // key's unbounded one still come from a single extraction.
  it('redacts without bounding, where the bounded form collapses the difference', () => {
    const shared = `compaction store read failed: ${'detail '.repeat(40)}`;
    expect(shared.length).toBeGreaterThan(MAX_RUN_EVENT_REASON_CHARS);

    expect(redactRunEventReason(new Error(`${shared}alpha`))).not.toBe(
      redactRunEventReason(new Error(`${shared}beta`))
    );
    expect(boundRunEventReason(new Error(`${shared}alpha`))).toBe(
      boundRunEventReason(new Error(`${shared}beta`))
    );
  });

  it('applies the identical redaction and extraction to Errors and non-Errors', () => {
    const message = 'connect https://alice:hunter2@host/mcp';
    // Under the bound the two agree exactly, which is what lets the latch key
    // and the rendered row describe the same text.
    expect(redactRunEventReason(new Error(message))).toBe(boundRunEventReason(new Error(message)));
    expect(redactRunEventReason(message)).not.toContain('hunter2');
    // An Error is unwrapped to its message; a bare string is not re-wrapped.
    expect(redactRunEventReason(new Error('plain'))).toBe('plain');
    expect(redactRunEventReason('Error: plain')).toBe('Error: plain');
  });
});
