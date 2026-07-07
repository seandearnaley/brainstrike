import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { PGlite } from '@electric-sql/pglite';
import type { StepResult, WorkflowRunState } from '@mastra/core/workflows';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MASTRA_WORKFLOW_TABLE } from '../sql';
import { PgliteWorkflowsStore } from '../workflows-store';

type ApprovalStepResult = StepResult<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
>;
type UnknownStepResult = StepResult<unknown, unknown, unknown, unknown>;

function createSnapshot(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    activePaths: [],
    activeStepsPath: {},
    context: {
      input: { requestId: 'request-1' },
    },
    resumeLabels: {},
    runId: 'run-1',
    serializedStepGraph: [],
    status: 'running',
    suspendedPaths: {},
    timestamp: Date.parse('2026-05-29T10:00:00Z'),
    value: {},
    waitingPaths: {},
    ...overrides,
  };
}

describe('PgliteWorkflowsStore', () => {
  let db: PGlite;
  let store: PgliteWorkflowsStore;

  beforeEach(async () => {
    db = new PGlite();
    store = new PgliteWorkflowsStore({ database: db });
    await store.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('creates Mastra workflow snapshot tables idempotently', async () => {
    await store.initialize();

    const tables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'mastra_workflow_snapshot'"
    );
    const snapshotColumn = await db.query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_name = 'mastra_workflow_snapshot'
         AND column_name = 'snapshot'`
    );
    const runIdLookupIndex = await db.query<{ indexdef: string; indexname: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'mastra_workflow_snapshot'
         AND indexname = 'mastra_workflow_snapshot_run_id_idx'`
    );

    expect(tables.rows.map((row) => row.tablename)).toEqual(['mastra_workflow_snapshot']);
    expect(snapshotColumn.rows[0]?.data_type).toBe('jsonb');
    expect(runIdLookupIndex.rows).toHaveLength(1);
    expect(runIdLookupIndex.rows[0]?.indexdef).toContain('(run_id)');
  });

  it('clears workflow snapshots before explicit schema initialization', async () => {
    const freshDb = new PGlite();
    const freshStore = new PgliteWorkflowsStore({ database: freshDb });

    try {
      await expect(freshStore.dangerouslyClearAll()).resolves.toBeUndefined();

      const tables = await freshDb.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'mastra_workflow_snapshot'"
      );
      expect(tables.rows.map((row) => row.tablename)).toEqual(['mastra_workflow_snapshot']);
    } finally {
      await freshDb.close();
    }
  });

  it('persists and reloads cloned workflow snapshots for approval resume', async () => {
    const snapshot = createSnapshot({
      context: {
        'approval-step': {
          payload: { requestId: 'approval-1' },
          startedAt: Date.parse('2026-05-29T10:00:00Z'),
          status: 'suspended',
          suspendedAt: Date.parse('2026-05-29T10:00:01Z'),
          suspendPayload: { reason: 'approval required' },
        },
        input: { requestId: 'approval-1' },
      },
      runId: 'approval-run-1',
      status: 'suspended',
      suspendedPaths: { 'approval-step': [0] },
    });

    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T10:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'approval-run-1',
      snapshot,
      updatedAt: new Date('2026-05-29T10:00:01Z'),
      workflowName: 'approval-workflow',
    });

    const loaded = await store.loadWorkflowSnapshot({
      runId: 'approval-run-1',
      workflowName: 'approval-workflow',
    });

    expect(loaded).toEqual(snapshot);
    if (!loaded) {
      throw new Error('Expected workflow snapshot to load');
    }
    loaded.context.input = { requestId: 'mutated' };

    await expect(
      store.loadWorkflowSnapshot({
        runId: 'approval-run-1',
        workflowName: 'approval-workflow',
      })
    ).resolves.toEqual(snapshot);
  });

  it('updates workflow state and step results without dropping snapshot context', async () => {
    await store.persistWorkflowSnapshot({
      runId: 'approval-run-1',
      snapshot: createSnapshot({ runId: 'approval-run-1' }),
      workflowName: 'approval-workflow',
    });

    const approvalResult: ApprovalStepResult = {
      endedAt: Date.parse('2026-05-29T10:01:00Z'),
      output: { approved: true },
      payload: { requestId: 'request-1' },
      resumedAt: Date.parse('2026-05-29T10:00:30Z'),
      startedAt: Date.parse('2026-05-29T10:00:00Z'),
      status: 'success',
    };

    const context = await store.updateWorkflowResults({
      requestContext: { userId: 'user-1' },
      result: approvalResult,
      runId: 'approval-run-1',
      stepId: 'approval-step',
      workflowName: 'approval-workflow',
    });
    const updated = await store.updateWorkflowState({
      opts: {
        resumeLabels: { approve: { stepId: 'approval-step' } },
        status: 'suspended',
        suspendedPaths: { 'approval-step': [0] },
        tracingContext: { parentSpanId: 'span-parent', spanId: 'span-1', traceId: 'trace-1' },
      },
      runId: 'approval-run-1',
      workflowName: 'approval-workflow',
    });

    expect(context['approval-step']).toEqual(approvalResult);
    expect(updated).toMatchObject({
      context: {
        'approval-step': approvalResult,
        input: { requestId: 'request-1' },
      },
      requestContext: { userId: 'user-1' },
      resumeLabels: { approve: { stepId: 'approval-step' } },
      status: 'suspended',
      suspendedPaths: { 'approval-step': [0] },
      tracingContext: { parentSpanId: 'span-parent', spanId: 'span-1', traceId: 'trace-1' },
    });
  });

  it('merges array step outputs while preserving prior values and pending markers', async () => {
    await store.persistWorkflowSnapshot({
      runId: 'approval-run-1',
      snapshot: createSnapshot({ runId: 'approval-run-1' }),
      workflowName: 'approval-workflow',
    });

    const initialResult: UnknownStepResult = {
      output: ['kept', 'replace-me'],
      status: 'success',
    };
    const resumedResult: UnknownStepResult = {
      output: [null, { __mastra_pending__: true }, 'new-value'],
      status: 'success',
    };

    await store.updateWorkflowResults({
      requestContext: {},
      result: initialResult,
      runId: 'approval-run-1',
      stepId: 'approval-step',
      workflowName: 'approval-workflow',
    });
    const context = await store.updateWorkflowResults({
      requestContext: {},
      result: resumedResult,
      runId: 'approval-run-1',
      stepId: 'approval-step',
      workflowName: 'approval-workflow',
    });
    const loaded = await store.loadWorkflowSnapshot({
      runId: 'approval-run-1',
      workflowName: 'approval-workflow',
    });

    expect(context['approval-step']?.output).toEqual(['kept', null, 'new-value']);
    expect(loaded?.context['approval-step']?.output).toEqual(['kept', null, 'new-value']);
  });

  it('reports stored workflow snapshots with missing context as malformed data', async () => {
    await db.query(
      `INSERT INTO ${MASTRA_WORKFLOW_TABLE}
        (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        'approval-workflow',
        'malformed-run',
        null,
        JSON.stringify({ runId: 'malformed-run', status: 'running' }),
        new Date('2026-05-29T10:00:00Z'),
        new Date('2026-05-29T10:00:01Z'),
      ]
    );

    await expect(
      store.loadWorkflowSnapshot({
        runId: 'malformed-run',
        workflowName: 'approval-workflow',
      })
    ).rejects.toThrow('Stored Mastra workflow snapshot for runId malformed-run is missing context');
  });

  it('skips malformed workflow snapshots while listing and logs the skipped row', async () => {
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });

    try {
      await store.persistWorkflowSnapshot({
        createdAt: new Date('2026-05-29T10:00:00Z'),
        runId: 'valid-run',
        snapshot: createSnapshot({ runId: 'valid-run', status: 'running' }),
        workflowName: 'approval-workflow',
      });
      await db.query(
        `INSERT INTO ${MASTRA_WORKFLOW_TABLE}
          (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          'approval-workflow',
          'malformed-run',
          null,
          JSON.stringify({ runId: 'malformed-run', status: 'running' }),
          new Date('2026-05-29T11:00:00Z'),
          new Date('2026-05-29T11:00:01Z'),
        ]
      );

      const listed = await store.listWorkflowRuns({ workflowName: 'approval-workflow' });

      expect(listed.runs.map((run) => run.runId)).toEqual(['valid-run']);
      expect(records).toContainEqual(
        expect.objectContaining({
          level: LogLevel.WARN,
          message: 'Skipping malformed Mastra workflow snapshot while listing workflow runs',
          scope: 'PgliteWorkflowsStore',
        })
      );
    } finally {
      unsubscribe();
    }
  });

  it('preserves the original createdAt when a workflow snapshot is re-persisted', async () => {
    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T10:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-original',
      snapshot: createSnapshot({ runId: 'run-original', status: 'running' }),
      updatedAt: new Date('2026-05-29T10:00:01Z'),
      workflowName: 'approval-workflow',
    });
    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T11:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-newer',
      snapshot: createSnapshot({ runId: 'run-newer', status: 'running' }),
      workflowName: 'approval-workflow',
    });
    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T12:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-original',
      snapshot: createSnapshot({ runId: 'run-original', status: 'success' }),
      updatedAt: new Date('2026-05-29T12:00:01Z'),
      workflowName: 'approval-workflow',
    });

    const listed = await store.listWorkflowRuns({
      resourceId: 'workspace-a',
      workflowName: 'approval-workflow',
    });
    const run = await store.getWorkflowRunById({
      runId: 'run-original',
      workflowName: 'approval-workflow',
    });

    expect(listed.runs.map((entry) => entry.runId)).toEqual(['run-newer', 'run-original']);
    expect(run?.createdAt).toEqual(new Date('2026-05-29T10:00:00Z'));
    expect(run?.updatedAt).toEqual(new Date('2026-05-29T12:00:01Z'));
    expect(run?.snapshot).toMatchObject({ runId: 'run-original', status: 'success' });
  });

  it('throws when workflow results are updated before a snapshot row exists', async () => {
    const approvalResult: ApprovalStepResult = {
      endedAt: Date.parse('2026-05-29T10:01:00Z'),
      output: { approved: true },
      payload: { requestId: 'request-1' },
      startedAt: Date.parse('2026-05-29T10:00:00Z'),
      status: 'success',
    };

    await expect(
      store.updateWorkflowResults({
        requestContext: { userId: 'user-1' },
        result: approvalResult,
        runId: 'missing-run',
        stepId: 'approval-step',
        workflowName: 'approval-workflow',
      })
    ).rejects.toThrow(
      'Cannot update workflow results before snapshot is persisted for workflow approval-workflow run missing-run'
    );
  });

  it('lists, filters, paginates, and deletes workflow runs', async () => {
    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T09:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-older',
      snapshot: createSnapshot({ runId: 'run-older', status: 'success' }),
      workflowName: 'approval-workflow',
    });
    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T11:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'run-newer',
      snapshot: createSnapshot({ runId: 'run-newer', status: 'suspended' }),
      workflowName: 'approval-workflow',
    });
    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T12:00:00Z'),
      resourceId: 'workspace-b',
      runId: 'run-other-resource',
      snapshot: createSnapshot({ runId: 'run-other-resource', status: 'suspended' }),
      workflowName: 'approval-workflow',
    });

    const listed = await store.listWorkflowRuns({
      page: 0,
      perPage: 1,
      resourceId: 'workspace-a',
      status: 'suspended',
      workflowName: 'approval-workflow',
    });
    const run = await store.getWorkflowRunById({
      runId: 'run-newer',
      workflowName: 'approval-workflow',
    });
    const firstPageDefault = await store.listWorkflowRuns({
      perPage: 1,
      resourceId: 'workspace-a',
      workflowName: 'approval-workflow',
    });

    expect(listed.total).toBe(1);
    expect(listed.runs.map((entry) => entry.runId)).toEqual(['run-newer']);
    expect(firstPageDefault.total).toBe(2);
    expect(firstPageDefault.runs.map((entry) => entry.runId)).toEqual(['run-newer']);
    expect(run).toMatchObject({
      resourceId: 'workspace-a',
      runId: 'run-newer',
      workflowName: 'approval-workflow',
    });
    expect(run?.createdAt).toEqual(new Date('2026-05-29T11:00:00Z'));
    expect(run?.snapshot).toMatchObject({ runId: 'run-newer', status: 'suspended' });
    await expect(store.getWorkflowRunById({ runId: 'run-newer' })).resolves.toMatchObject({
      resourceId: 'workspace-a',
      runId: 'run-newer',
      workflowName: 'approval-workflow',
    });

    await store.deleteWorkflowRunById({
      runId: 'run-newer',
      workflowName: 'approval-workflow',
    });

    await expect(
      store.getWorkflowRunById({ runId: 'run-newer', workflowName: 'approval-workflow' })
    ).resolves.toBeNull();
  });

  it('uses stable tie breakers when paginating workflow runs with matching createdAt values', async () => {
    const sharedCreatedAt = new Date('2026-05-29T10:00:00Z');

    await store.persistWorkflowSnapshot({
      createdAt: sharedCreatedAt,
      runId: 'run-2',
      snapshot: createSnapshot({ runId: 'run-2' }),
      workflowName: 'approval-workflow',
    });
    await store.persistWorkflowSnapshot({
      createdAt: sharedCreatedAt,
      runId: 'run-1',
      snapshot: createSnapshot({ runId: 'run-1' }),
      workflowName: 'review-workflow',
    });
    await store.persistWorkflowSnapshot({
      createdAt: sharedCreatedAt,
      runId: 'run-1',
      snapshot: createSnapshot({ runId: 'run-1' }),
      workflowName: 'approval-workflow',
    });

    const firstPage = await store.listWorkflowRuns({ page: 0, perPage: 1 });
    const secondPage = await store.listWorkflowRuns({ page: 1, perPage: 1 });
    const thirdPage = await store.listWorkflowRuns({ page: 2, perPage: 1 });

    expect([
      ...firstPage.runs.map((entry) => `${entry.runId}:${entry.workflowName}`),
      ...secondPage.runs.map((entry) => `${entry.runId}:${entry.workflowName}`),
      ...thirdPage.runs.map((entry) => `${entry.runId}:${entry.workflowName}`),
    ]).toEqual(['run-1:approval-workflow', 'run-1:review-workflow', 'run-2:approval-workflow']);
    expect(firstPage.total).toBe(3);
    expect(secondPage.total).toBe(3);
    expect(thirdPage.total).toBe(3);
  });

  it('requires workflowName when a run id is not globally unique', async () => {
    await store.persistWorkflowSnapshot({
      runId: 'shared-run-id',
      snapshot: createSnapshot({ runId: 'shared-run-id' }),
      workflowName: 'approval-workflow',
    });
    await store.persistWorkflowSnapshot({
      runId: 'shared-run-id',
      snapshot: createSnapshot({ runId: 'shared-run-id' }),
      workflowName: 'audit-workflow',
    });

    await expect(store.getWorkflowRunById({ runId: 'shared-run-id' })).rejects.toThrow(
      'workflowName is required'
    );
  });

  it('retries schema initialization after a transient bootstrap failure', async () => {
    const database = {
      exec: vi
        .fn<(sql: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error('temporary workflow bootstrap failure'))
        .mockResolvedValue(undefined),
      query: vi.fn(),
    };
    const transientStore = new PgliteWorkflowsStore({ database });

    await expect(transientStore.initialize()).rejects.toThrow(
      'temporary workflow bootstrap failure'
    );
    await expect(transientStore.initialize()).resolves.toBeUndefined();
    expect(database.exec).toHaveBeenCalledTimes(2);
  });
});
