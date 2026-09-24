/**
 * Managed-worktree lifecycle breadcrumbs through the production main-process
 * writer against real PGlite and real git worktrees (BST-1390).
 */
import { rmSync } from 'node:fs';
import { MASTRA_MEMORY_TABLES } from '@brainstrike/assistant-contract';
import type { HostRunId } from '@brainstrike/assistant-contract/host-run-id';
import { createPgliteAssistantThreadRepository } from '@brainstrike/assistant-data';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordDesktopAssistantRunEvent } from '../../assistant-server/run-persistence';
import type { createWorktreeService } from '../../assistant-server/worktree-service';
import { buildTestService, createTestWorkspace } from './worktree-service.shared';

async function seedRunRow(
  db: PGlite,
  input: { readonly runId: string; readonly threadId: string }
): Promise<void> {
  const now = new Date();
  await db.query(
    `INSERT INTO ${MASTRA_MEMORY_TABLES.threads}
      (id, "resourceId", title, metadata, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [input.threadId, 'workspace-a', 'Seeded thread', JSON.stringify({}), now, now]
  );
  const repository = createPgliteAssistantThreadRepository(db as DbHandle);
  await repository.createThreadRun({
    id: input.runId as HostRunId,
    model: 'gpt-5.2',
    provider: 'openai',
    resourceId: 'workspace-a',
    runtimeKind: 'hosted',
    threadId: input.threadId,
  });
}

describe('worktree run events (real PGlite)', () => {
  let db: PGlite;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    buildTestService({ db, managedDirectory, repo }, overrides);

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    await runMigrations(db);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    await repository.listThreads('workspace-a');
    repo = workspace.freshRepo('run-events');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it('writes worktree.created with via app for a user-created worktree', async () => {
    await seedRunRow(db, { runId: 'run-1', threadId: 't-1' });
    const service = buildService({
      recordRunEvent: (runId, event) =>
        recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/timeline' },
      createdBy: 'user',
      name: 'timeline',
      rootId: 'r-1',
      runId: 'run-1',
      threadId: 't-1',
    });
    const rows = await db.query<{ kind: string; label: string; via: string }>(
      "SELECT kind, label, metadata->>'via' AS via FROM brainstrike_assistant_run_events WHERE run_id = 'run-1' ORDER BY kind"
    );
    expect(rows.rows.map((row) => row.kind)).toEqual(['worktree.created']);
    expect(rows.rows[0]?.label).toBe('Created worktree timeline');
    expect(rows.rows[0]?.via).toBe('app');
  });

  it('writes worktree.created with via tool for an agent-created worktree', async () => {
    // The manageWorktree tool executor's capability binds `createdBy: 'agent'`
    // server-side (buildDesktopToolDependencies in assistant-server.ts); this
    // is that call site's exact params shape, and the row it inserts is what
    // must select the 'tool' breadcrumb — not a second hardcoded 'app'.
    await seedRunRow(db, { runId: 'run-tool', threadId: 't-tool' });
    const service = buildService({
      recordRunEvent: (runId, event) =>
        recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/agent-made' },
      createdBy: 'agent',
      name: 'agent-made',
      rootId: 'r-1',
      runId: 'run-tool',
      threadId: 't-tool',
    });
    const rows = await db.query<{ kind: string; via: string }>(
      "SELECT kind, metadata->>'via' AS via FROM brainstrike_assistant_run_events WHERE run_id = 'run-tool'"
    );
    expect(rows.rows).toEqual([{ kind: 'worktree.created', via: 'tool' }]);
  });

  it('writes NOTHING (and does not fail) with no run', async () => {
    const service = buildService({
      recordRunEvent: (runId, event) =>
        recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/norun' },
      createdBy: 'user',
      name: 'norun',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_assistant_run_events'
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('writes worktree.setup with status failed when the setup command fails', async () => {
    await seedRunRow(db, { runId: 'run-2', threadId: 't-2' });
    const service = buildService({
      recordRunEvent: (runId, event) =>
        recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
      runSetup: () =>
        Promise.resolve({
          copiedPaths: [],
          output: 'boom',
          reason: 'Setup command exited with code 3.',
          skippedCopies: [],
          status: 'failed' as const,
          truncated: false,
        }),
    });
    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/setupfail' },
      createdBy: 'user',
      name: 'setupfail',
      rootId: 'r-1',
      runId: 'run-2',
      threadId: 't-2',
    });
    const rows = await db.query<{ detail: string; kind: string; status: string }>(
      "SELECT kind, status, detail FROM brainstrike_assistant_run_events WHERE kind = 'worktree.setup'"
    );
    expect(rows.rows[0]).toMatchObject({
      detail: 'Setup command exited with code 3.',
      status: 'failed',
    });
  });

  it('does not fail worktree creation when event payload construction throws', async () => {
    await seedRunRow(db, { runId: 'run-payload', threadId: 't-payload' });
    const service = buildService({
      recordRunEvent: (runId, event) =>
        recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
      runSetup: () =>
        Promise.resolve({
          get copiedPaths(): readonly string[] {
            throw new Error('payload construction failed');
          },
          output: '',
          reason: null,
          skippedCopies: [],
          status: 'succeeded' as const,
          truncated: false,
        }),
    });

    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/payload-guard' },
      createdBy: 'user',
      name: 'payload-guard',
      rootId: 'r-1',
      runId: 'run-payload',
      threadId: 't-payload',
    });

    expect(created.ok).toBe(true);
    const rows = await db.query<{ kind: string }>(
      "SELECT kind FROM brainstrike_assistant_run_events WHERE run_id = 'run-payload' ORDER BY kind"
    );
    expect(rows.rows.map((row) => row.kind)).toEqual(['worktree.created']);
  });

  it('writes worktree.archived with the snapshot ref', async () => {
    await seedRunRow(db, { runId: 'run-3', threadId: 't-3' });
    const service = buildService({
      recordRunEvent: (runId, event) =>
        recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/arch' },
      createdBy: 'user',
      name: 'arch',
      rootId: 'r-1',
      runId: 'run-3',
      threadId: 't-3',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await db.query(
      "UPDATE brainstrike_assistant_thread_runs SET status = 'completed', completed_at = NOW() WHERE id = 'run-3'"
    );
    const archived = await service.archive({
      runId: 'run-3',
      worktreeId: created.value.worktree.id,
    });
    expect(archived).toMatchObject({ ok: true });
    if (!archived.ok) {
      return;
    }
    const rows = await db.query<{ detail: string }>(
      "SELECT detail FROM brainstrike_assistant_run_events WHERE kind = 'worktree.archived'"
    );
    expect(rows.rows[0]?.detail).toContain('refs/brainstrike/worktree-archive/');
  });

  it('writes worktree.archived when the worktree vanishes during an active run', async () => {
    await seedRunRow(db, { runId: 'run-vanished', threadId: 't-vanished' });
    const service = buildService({
      recordRunEvent: (runId, event) =>
        recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/vanished-event' },
      createdBy: 'user',
      name: 'vanished-event',
      rootId: 'r-1',
      runId: 'run-vanished',
      threadId: 't-vanished',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    rmSync(created.value.worktree.path, { force: true, recursive: true });

    const archived = await service.archive({
      runId: 'run-vanished',
      worktreeId: created.value.worktree.id,
    });

    expect(archived.ok).toBe(true);
    const rows = await db.query<{ detail: string; kind: string; label: string }>(
      "SELECT kind, label, detail FROM brainstrike_assistant_run_events WHERE run_id = 'run-vanished' AND kind = 'worktree.archived'"
    );
    expect(rows.rows).toEqual([
      {
        detail: `Snapshot refs/brainstrike/worktree-archive/${created.value.worktree.id}`,
        kind: 'worktree.archived',
        label: 'Archived worktree vanished-event',
      },
    ]);
  });
});
