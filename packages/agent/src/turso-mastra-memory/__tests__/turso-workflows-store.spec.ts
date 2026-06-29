import type { StepResult, WorkflowRunState } from '@mastra/core/workflows';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MASTRA_WORKFLOW_TABLE } from '../sql';
import { TursoWorkflowsStore } from '../workflows-store';
import { createTursoTestClient, type TursoTestClient } from './turso-test-client';

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

describe('TursoWorkflowsStore', () => {
  let runtime: TursoTestClient;
  let store: TursoWorkflowsStore;

  beforeEach(async () => {
    runtime = await createTursoTestClient('brainstrike-turso-workflows-');
    store = new TursoWorkflowsStore({ database: runtime.client });
    await store.initialize();
  });

  afterEach(async () => {
    await runtime.close();
  });

  it('creates SQLite workflow snapshot tables idempotently', async () => {
    await store.initialize();

    const tables = await runtime.client.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [MASTRA_WORKFLOW_TABLE]
    );
    const snapshotColumn = await runtime.client.query<{ type: string }>(
      `SELECT type
       FROM pragma_table_info(?)
       WHERE name = ?`,
      [MASTRA_WORKFLOW_TABLE, 'snapshot']
    );

    expect(tables.rows.map((row) => row.name)).toEqual([MASTRA_WORKFLOW_TABLE]);
    expect(snapshotColumn.rows[0]?.type).toBe('TEXT');
  });

  it('persists, updates, and lists workflow snapshots through SQLite JSON', async () => {
    await store.persistWorkflowSnapshot({
      createdAt: new Date('2026-05-29T10:00:00Z'),
      resourceId: 'workspace-a',
      runId: 'approval-run-1',
      snapshot: createSnapshot({ runId: 'approval-run-1' }),
      updatedAt: new Date('2026-05-29T10:00:01Z'),
      workflowName: 'approval-workflow',
    });

    const result: UnknownStepResult = {
      output: ['kept', 'replace-me'],
      status: 'success',
    };
    await store.updateWorkflowResults({
      requestContext: { userId: 'user-1' },
      result,
      runId: 'approval-run-1',
      stepId: 'approval-step',
      workflowName: 'approval-workflow',
    });
    await store.updateWorkflowState({
      opts: { status: 'suspended', suspendedPaths: { 'approval-step': [0] } },
      runId: 'approval-run-1',
      workflowName: 'approval-workflow',
    });

    const loaded = await store.loadWorkflowSnapshot({
      runId: 'approval-run-1',
      workflowName: 'approval-workflow',
    });
    const listed = await store.listWorkflowRuns({
      resourceId: 'workspace-a',
      status: 'suspended',
      perPage: false,
    });

    expect(loaded).toMatchObject({
      context: {
        input: { requestId: 'request-1' },
        'approval-step': result,
      },
      requestContext: { userId: 'user-1' },
      status: 'suspended',
    });
    expect(listed.runs.map((run) => run.runId)).toEqual(['approval-run-1']);
    expect(runtime.queries.join('\n')).not.toMatch(/\$1|::|->>|JSONB|TIMESTAMPTZ/);
  });
});
