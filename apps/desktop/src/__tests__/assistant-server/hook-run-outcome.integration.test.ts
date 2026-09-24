import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
/**
 * Task Ledger source 'hook': the main-process assistant-server records a
 * Stop-hook-reported run verdict against REAL PGlite via
 * `recordDesktopAssistantHookRunOutcome`.
 *
 * Precedence contract under test (enforced in SQL, never in caller logic):
 * - a hook verdict lands with source 'hook' (thread/resource ids derived from
 *   the runs row, mirroring recordDesktopAssistantRunEvent);
 * - a hook verdict NEVER overwrites an existing 'user' label (skip, not error);
 * - a later USER verdict (repository write path) still overwrites a hook label;
 * - a hook verdict may replace a derived 'edit_revert' label and an earlier
 *   hook label;
 * - a verdict for an unknown run id THROWS (no silent no-op).
 *
 * The schema comes from the REAL repository bootstrap (byte-identical to
 * migration 060), so the guarded upsert is proven against the production shape.
 */

// Real repository (schema bootstrap + the renderer-side recordRunOutcome used
// for the user-precedence half of the contract). Imported via app-shell's
// assistant-data package, the same convention as
// run-usage-live-loop.integration.test.ts; placement is interim per R04 (BST-984).
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import { recordDesktopAssistantHookRunOutcome } from '../../assistant-server/run-persistence';

interface OutcomeRow {
  detail: string | null;
  resource_id: string;
  source: string;
  thread_id: string;
  verdict: string;
}

async function readOutcome(db: Awaited<ReturnType<typeof wasmLoader.createPGlite>>, runId: string) {
  const result = (await db.query(
    'SELECT thread_id, resource_id, verdict, source, detail FROM brainstrike_assistant_run_outcomes WHERE run_id = $1',
    [runId]
  )) as { rows: OutcomeRow[] };
  return result.rows;
}

describe('recordDesktopAssistantHookRunOutcome (real PGlite)', () => {
  async function setup(name: string) {
    const db = await wasmLoader.createPGlite(`memory://hook-run-outcome-${name}-${Date.now()}`);
    // Migrations 117/118 own the assistant schema (BST-1651).
    await migrate(db);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    // thread_runs carries an FK to the (Mastra) threads table, so a real
    // thread row must exist first — same shape as production.
    const thread = await repository.createThread('workspace-a');
    await repository.createThreadRun({
      id: 'run-1' as HostRunId,
      model: 'gpt-5.2',
      provider: 'openai',
      resourceId: 'workspace-a',
      runtimeKind: 'hosted',
      threadId: thread.id,
    });
    return { db, repository, threadId: thread.id };
  }

  it('records a hook verdict with source hook, deriving thread/resource from the run row', async () => {
    const { db, threadId } = await setup('insert');
    try {
      await recordDesktopAssistantHookRunOutcome(db, 'run-1', {
        detail: '3 tests failing',
        verdict: 'failed',
      });
      expect(await readOutcome(db, 'run-1')).toEqual([
        {
          detail: '3 tests failing',
          resource_id: 'workspace-a',
          source: 'hook',
          thread_id: threadId,
          verdict: 'failed',
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it('never overwrites an existing user label (skip, not error)', async () => {
    const { db, repository, threadId } = await setup('user-precedence');
    try {
      await repository.recordRunOutcome({
        detail: 'user says fine',
        resourceId: 'workspace-a',
        runId: 'run-1',
        source: 'user',
        threadId,
        verdict: 'succeeded',
      });
      await recordDesktopAssistantHookRunOutcome(db, 'run-1', { verdict: 'failed' });
      expect(await readOutcome(db, 'run-1')).toEqual([
        {
          detail: 'user says fine',
          resource_id: 'workspace-a',
          source: 'user',
          thread_id: threadId,
          verdict: 'succeeded',
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it('a later user verdict still overwrites a hook label (repository path)', async () => {
    const { db, repository, threadId } = await setup('user-overwrites');
    try {
      await recordDesktopAssistantHookRunOutcome(db, 'run-1', { verdict: 'failed' });
      await repository.recordRunOutcome({
        resourceId: 'workspace-a',
        runId: 'run-1',
        source: 'user',
        threadId,
        verdict: 'succeeded',
      });
      expect(await readOutcome(db, 'run-1')).toEqual([
        {
          detail: null,
          resource_id: 'workspace-a',
          source: 'user',
          thread_id: threadId,
          verdict: 'succeeded',
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it('replaces an earlier hook or edit_revert label (upsert on run_id)', async () => {
    const { db, repository, threadId } = await setup('replaces-derived');
    try {
      await repository.recordRunOutcome({
        resourceId: 'workspace-a',
        runId: 'run-1',
        source: 'edit_revert',
        threadId,
        verdict: 'failed',
      });
      await recordDesktopAssistantHookRunOutcome(db, 'run-1', {
        detail: 'suite green on rerun',
        verdict: 'mixed',
      });
      expect(await readOutcome(db, 'run-1')).toEqual([
        {
          detail: 'suite green on rerun',
          resource_id: 'workspace-a',
          source: 'hook',
          thread_id: threadId,
          verdict: 'mixed',
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it('throws for an unknown run id (no silent no-op)', async () => {
    const { db } = await setup('unknown-run');
    try {
      await expect(
        recordDesktopAssistantHookRunOutcome(db, 'run-missing', { verdict: 'failed' })
      ).rejects.toThrow(/run-missing/);
      expect(await readOutcome(db, 'run-missing')).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
