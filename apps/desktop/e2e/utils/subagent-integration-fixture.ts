import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Request } from '@playwright/test';
import {
  type ModelProviderRequest,
  type ModelProviderShim,
  startModelProviderShim,
} from './model-provider-shim';

export const assembledMarkers = {
  parentPrompt: 'ASSEMBLED_ROOT_FANOUT_1770',
  parentResult: 'ASSEMBLED_ROOT_COMPLETE_1770',
  parkedApproved: 'PARKED_APPROVED_COMPLETE_1770',
  streamA: 'STREAM_ALPHA_COMPLETE_1770',
  streamB: 'STREAM_BETA_COMPLETE_1770',
} as const;

export interface AssembledSubagentFixture {
  readonly environment: Readonly<Record<string, string>>;
  readonly provider: ModelProviderShim;
  readonly releaseAlpha: () => void;
  readonly releaseBeta: () => void;
  readonly requests: () => readonly ModelProviderRequest[];
}

export interface AssistantNetworkRecord {
  readonly action?: string;
  readonly continuationId?: string;
  readonly method: string;
  readonly path: string;
  readonly runId?: string;
  readonly status: number | 'failed' | null;
  readonly toolCallId?: string;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!(value && typeof value === 'object' && key in value)) {
    return;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/** Records only assistant stream/decision routing metadata; headers and model bodies stay excluded. */
export function captureAssistantNetwork(page: Page): () => readonly AssistantNetworkRecord[] {
  const records: AssistantNetworkRecord[] = [];
  const pending = new Map<Request, number>();
  const matches = (pathname: string): boolean =>
    pathname === '/assistant' ||
    pathname === '/assistant/decide' ||
    pathname === '/assistant/resume' ||
    pathname === '/assistant/cancel';

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!matches(url.pathname)) {
      return;
    }
    let body: unknown;
    if (url.pathname === '/assistant/decide') {
      try {
        body = request.postDataJSON();
      } catch {
        body = undefined;
      }
    }
    const action = body && typeof body === 'object' && 'action' in body ? body.action : undefined;
    const decision = stringField(action, 'action');
    const continuationId = stringField(action, 'continuationId');
    const runId = stringField(body, 'runId');
    const toolCallId = stringField(action, 'toolCallId');
    pending.set(request, records.length);
    records.push({
      ...(decision ? { action: decision } : {}),
      ...(continuationId ? { continuationId } : {}),
      method: request.method(),
      path: url.pathname,
      ...(runId ? { runId } : {}),
      status: null,
      ...(toolCallId ? { toolCallId } : {}),
    });
  });
  page.on('response', (response) => {
    const index = pending.get(response.request());
    if (index === undefined) {
      return;
    }
    const record = records[index];
    if (record) {
      records[index] = { ...record, status: response.status() };
    }
    pending.delete(response.request());
  });
  page.on('requestfailed', (request) => {
    const index = pending.get(request);
    if (index === undefined) {
      return;
    }
    const record = records[index];
    if (record) {
      records[index] = { ...record, status: 'failed' };
    }
    pending.delete(request);
  });
  return () => records.map((record) => ({ ...record }));
}

function userHistory(request: ModelProviderRequest): string {
  return JSON.stringify(
    request.messages
      .filter(
        (message) =>
          message && typeof message === 'object' && 'role' in message && message.role === 'user'
      )
      .at(-1)
  );
}

function hasAssistantToolCall(request: ModelProviderRequest, name: string): boolean {
  return request.messages.some((message) => {
    if (
      !(message && typeof message === 'object' && 'role' in message && message.role === 'assistant')
    ) {
      return false;
    }
    const calls = 'tool_calls' in message ? message.tool_calls : undefined;
    return (
      Array.isArray(calls) &&
      calls.some(
        (call) =>
          call &&
          typeof call === 'object' &&
          'function' in call &&
          call.function &&
          typeof call.function === 'object' &&
          'name' in call.function &&
          call.function.name === name
      )
    );
  });
}

export async function createAssembledSubagentFixture(
  workspace: string
): Promise<AssembledSubagentFixture> {
  const agents = path.join(workspace, '.brainstrike', 'agents');
  await mkdir(agents, { recursive: true });
  const personas = [
    [
      'stream-alpha',
      'Stream Alpha',
      'Read evidence.txt, then report completion.',
      'readWorkspaceFile',
    ],
    [
      'stream-beta',
      'Stream Beta',
      'Read evidence.txt, then report completion.',
      'readWorkspaceFile',
    ],
    [
      'parked-grant',
      'Parked Grant',
      'Read evidence.txt and report its marker.',
      'readWorkspaceFile',
    ],
    ['parked-stop', 'Parked Stop', 'Read evidence.txt and report its marker.', 'readWorkspaceFile'],
  ] as const;
  await Promise.all(
    personas.map(([file, name, body, tool]) =>
      writeFile(
        path.join(agents, `${file}.md`),
        `---\nname: ${name}\ndescription: BST-1770 assembled fixture specialist.${tool ? `\ntools:\n  - ${tool}` : ''}\n---\n${body}`
      )
    )
  );
  await writeFile(path.join(workspace, 'evidence.txt'), 'ASSEMBLED_EVIDENCE_1770');

  const alpha = Promise.withResolvers<void>();
  const beta = Promise.withResolvers<void>();
  const requests: ModelProviderRequest[] = [];
  const provider = await startModelProviderShim((request) => {
    requests.push(request);
    if (request.toolNames.length === 0) {
      return { finalText: 'Assembled specialist task' };
    }
    const users = userHistory(request);
    const history = JSON.stringify(request.messages);
    if (request.toolNames.includes('agent-stream-alpha')) {
      if (
        history.includes(assembledMarkers.streamB) &&
        history.includes(assembledMarkers.parkedApproved) &&
        history.includes('PARKED_STOP_SURVIVOR_COMPLETE_1770')
      ) {
        return { finalText: assembledMarkers.parentResult };
      }
      if (
        history.includes('Background task started.') ||
        hasAssistantToolCall(request, 'agent-stream-alpha')
      ) {
        return { finalText: 'ASSEMBLED_ROOT_CONTINUES_1770' };
      }
      return {
        finalText: 'ASSEMBLED_ROOT_CONTINUES_1770',
        toolCalls: [
          {
            arguments: {
              _background: { enabled: true },
              prompt: 'PARKED_GRANT_TASK_1770',
            },
            name: 'agent-parked-grant',
          },
          {
            arguments: {
              _background: { enabled: true },
              prompt: 'PARKED_STOP_TASK_1770',
            },
            name: 'agent-parked-stop',
          },
          {
            arguments: {
              _background: { enabled: true },
              prompt: 'STREAM_ALPHA_TASK_1770',
            },
            name: 'agent-stream-alpha',
          },
          {
            arguments: {
              _background: { enabled: true },
              prompt: 'STREAM_BETA_TASK_1770',
            },
            name: 'agent-stream-beta',
          },
        ],
      };
    }
    if (users.includes('STREAM_ALPHA_TASK_1770')) {
      return {
        beforeToolFinish: alpha.promise,
        finalText: assembledMarkers.streamA,
        toolCall: {
          arguments: { path: 'evidence.txt' },
          name: 'brainstrike_readWorkspaceFile',
        },
      };
    }
    if (users.includes('STREAM_BETA_TASK_1770')) {
      return {
        beforeToolFinish: beta.promise,
        finalText: assembledMarkers.streamB,
        toolCall: {
          arguments: { path: 'evidence.txt' },
          name: 'brainstrike_readWorkspaceFile',
        },
      };
    }
    return {
      finalText: users.includes('PARKED_STOP_TASK_1770')
        ? 'PARKED_STOP_SURVIVOR_COMPLETE_1770'
        : assembledMarkers.parkedApproved,
      toolCall: {
        arguments: { path: 'evidence.txt' },
        name: 'brainstrike_readWorkspaceFile',
      },
    };
  });
  return {
    environment: {
      ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: workspace,
      ['BRAINSTRIKE_OPENROUTER_API_KEY']: 'assembled-subagent-fixture-key',
      ['OPENROUTER_BASE_URL']: provider.baseUrl,
    },
    provider,
    releaseAlpha: alpha.resolve,
    releaseBeta: beta.resolve,
    requests: () => [...requests],
  };
}

export interface AssembledPersistenceSnapshot {
  readonly children: readonly {
    readonly displayName: string;
    readonly generationRunId: string;
    readonly hostRunId: string;
    readonly invocationId: string;
    readonly invocationCount: number;
    readonly invocationMatchesTask: boolean;
    readonly messageCount: number;
    readonly hasAbortMarker: boolean;
    readonly parentToolCallId: string;
    readonly status: string;
    readonly taskResult: unknown;
    readonly taskPrompt: string;
    readonly taskStatus: string;
    readonly usageRows: number;
  }[];
  readonly generationRunIds: readonly string[];
  readonly latestHostError: unknown;
  readonly latestHostGenerationRunId: string;
  readonly latestHostRunId: string;
  readonly latestHostStatus: string;
  readonly nativeRunCount: number;
  readonly parentMessageCount: number;
  readonly parentResultSlots: readonly {
    readonly snapshots: readonly {
      readonly errorText: unknown;
      readonly result: unknown;
      readonly state: string;
    }[];
    readonly toolCallId: string;
  }[];
  readonly terminalEvents: readonly { readonly kind: string; readonly toolCallId: string }[];
  readonly workspaceReadCompletions: number;
}

export async function readAssembledPersistence(page: Page): Promise<AssembledPersistenceSnapshot> {
  return page.evaluate(async () => {
    const query = (
      globalThis as typeof globalThis & {
        electronAPI?: {
          db?: {
            query?: (sql: string) => Promise<{
              rows: Array<{
                count: string;
                displayName: string;
                errorText: unknown;
                error: unknown;
                generationRunId: string;
                hasResult: boolean;
                hostRunId: string;
                id: string;
                invocationId: string;
                kind: string;
                invocationCount: string;
                invocationMatchesTask: boolean;
                messageCount: string;
                hasAbortMarker: boolean;
                parentMessageCount: string;
                parentToolCallId: string;
                result: unknown;
                rootThreadId: string;
                status: string;
                state: string;
                taskResult: unknown;
                taskPrompt: string;
                taskStatus: string;
                threadId: string;
                toolCallId: string;
                usageRows: string;
              }>;
            }>;
          };
        };
      }
    ).electronAPI?.db?.query;
    if (!query) {
      throw new Error('Native database bridge unavailable');
    }
    const rows = (
      await query(`SELECT child.thread_id AS "threadId", child.display_name AS "displayName",
        count(DISTINCT message.id)::text AS "messageCount",
        bool_or(message.content::text LIKE '%[Assistant turn aborted before completion.]%') AS "hasAbortMarker",
        count(DISTINCT usage.id)::text AS "usageRows",
        count(DISTINCT invocation.parent_tool_call_id)::text AS "invocationCount",
        jsonb_build_array(invocation.root_thread_id, invocation.parent_runtime_run_id,
          invocation.parent_tool_call_id)::text AS "invocationId",
        invocation.parent_tool_call_id AS "parentToolCallId",
        invocation.host_run_id AS "hostRunId",
        host_run.generation_run_id AS "generationRunId",
        bool_and(task.tool_call_id = invocation.parent_tool_call_id
          AND task.thread_id = child.root_thread_id) AS "invocationMatchesTask",
        coalesce((array_agg(run.status ORDER BY run.created_at DESC))[1], 'missing') AS status,
        coalesce((array_agg(task.status ORDER BY task."createdAt" DESC))[1], 'missing') AS "taskStatus",
        (array_agg(task.result ORDER BY task."createdAt" DESC))[1] AS "taskResult",
        (array_agg(task.args->>'prompt' ORDER BY task."createdAt" DESC))[1] AS "taskPrompt",
        (SELECT count(*)::text FROM mastra_messages root_message
          WHERE root_message.thread_id = child.root_thread_id) AS "parentMessageCount"
      FROM brainstrike_delegated_conversations child
      LEFT JOIN mastra_messages message ON message.thread_id = child.thread_id
      LEFT JOIN brainstrike_assistant_thread_runs run ON run.thread_id = child.thread_id
      LEFT JOIN brainstrike_delegated_invocations invocation ON invocation.thread_id = child.thread_id
      LEFT JOIN brainstrike_assistant_run_usage usage
        ON usage.thread_id = invocation.root_thread_id
        AND usage.resource_id = invocation.owner_resource_id
        AND usage.delegation_parent_run_id = invocation.parent_runtime_run_id
        AND usage.delegation_tool_call_id = invocation.parent_tool_call_id
      LEFT JOIN brainstrike_assistant_thread_runs host_run ON host_run.id = invocation.host_run_id
      LEFT JOIN mastra_background_tasks task ON task.tool_call_id = invocation.parent_tool_call_id
      WHERE child.parent_thread_id IS NOT NULL
      GROUP BY child.thread_id, child.display_name, child.root_thread_id,
        invocation.root_thread_id, invocation.parent_runtime_run_id,
        invocation.parent_tool_call_id, invocation.host_run_id, host_run.generation_run_id
      ORDER BY child.created_at`)
    ).rows;
    const rootThreadId = (
      await query(`SELECT root_thread_id AS "rootThreadId"
        FROM brainstrike_delegated_conversations
        WHERE parent_thread_id IS NOT NULL
        ORDER BY created_at LIMIT 1`)
    ).rows[0]?.rootThreadId as string | undefined;
    if (!rootThreadId) {
      return {
        children: [],
        generationRunIds: [],
        latestHostError: null,
        latestHostGenerationRunId: 'missing',
        latestHostRunId: 'missing',
        latestHostStatus: 'missing',
        nativeRunCount: 0,
        parentMessageCount: 0,
        parentResultSlots: [],
        terminalEvents: [],
        workspaceReadCompletions: 0,
      };
    }
    const hostRows = (
      await query(`SELECT id, status, error, generation_run_id AS "generationRunId"
        FROM brainstrike_assistant_thread_runs
        WHERE thread_id = '${rootThreadId.replaceAll("'", "''")}'
        ORDER BY started_at DESC, id DESC`)
    ).rows as Array<{ generationRunId: string; id: string; status: string; error: unknown }>;
    const nativeRunCount = Number(
      (
        await query(`SELECT count(*)::text AS count
          FROM brainstrike_assistant_native_runs native
          JOIN brainstrike_assistant_thread_runs host ON host.id = native.host_run_id
          WHERE host.thread_id = '${rootThreadId.replaceAll("'", "''")}'`)
      ).rows[0]?.count ?? 0
    );
    const scopedThreadIds = [rootThreadId, ...rows.map((row) => row.threadId)]
      .map((threadId) => `'${threadId.replaceAll("'", "''")}'`)
      .join(', ');
    const effectCount = Number(
      (
        await query(`SELECT count(DISTINCT metadata->>'toolCallId')::text AS count
          FROM brainstrike_assistant_run_events
          WHERE thread_id IN (${scopedThreadIds})
            AND ((kind = 'tool.completed'
              AND metadata->>'toolName' IN ('brainstrike.readWorkspaceFile', 'brainstrike_readWorkspaceFile'))
            OR (kind = 'subagent.tool.completed'
              AND metadata->>'childToolName' IN ('brainstrike.readWorkspaceFile', 'brainstrike_readWorkspaceFile')))`)
      ).rows[0]?.count ?? 0
    );
    const parentSnapshots = (
      await query(`SELECT
          part->'toolInvocation'->>'toolCallId' AS "toolCallId",
          part->'toolInvocation'->>'state' AS state,
          part->'toolInvocation'->'result' AS result,
          part->'toolInvocation'->'errorText' AS "errorText"
        FROM mastra_messages message
        CROSS JOIN LATERAL jsonb_array_elements(message.content->'parts') part
        WHERE message.thread_id = '${rootThreadId.replaceAll("'", "''")}'
          AND part->>'type' = 'tool-invocation'
          AND part->'toolInvocation'->>'toolName' LIKE 'agent-%'
        ORDER BY message."createdAt", message.id`)
    ).rows as Array<{ errorText: unknown; result: unknown; state: string; toolCallId: string }>;
    const parentResultSlots = [
      ...new Set(parentSnapshots.map((snapshot) => snapshot.toolCallId)),
    ].map((toolCallId) => ({
      snapshots: parentSnapshots
        .filter((snapshot) => snapshot.toolCallId === toolCallId)
        .map(({ errorText, result, state }) => ({ errorText, result, state })),
      toolCallId,
    }));
    const terminalEvents = (
      await query(`SELECT event.kind,
      invocation.parent_tool_call_id AS "toolCallId"
      FROM brainstrike_assistant_run_events event
      JOIN brainstrike_assistant_thread_runs run ON run.id = event.run_id
      JOIN brainstrike_delegated_invocations invocation ON invocation.thread_id = run.thread_id
      WHERE event.kind IN ('run.cancelled', 'run.failed', 'run.finished')
      ORDER BY invocation.parent_tool_call_id`)
    ).rows.map(({ kind, toolCallId }) => ({ kind, toolCallId }));
    return {
      children: rows.map((row) => ({
        displayName: row.displayName,
        generationRunId: row.generationRunId,
        hasAbortMarker: row.hasAbortMarker,
        hostRunId: row.hostRunId,
        invocationCount: Number(row.invocationCount),
        invocationId: row.invocationId,
        invocationMatchesTask: row.invocationMatchesTask,
        messageCount: Number(row.messageCount),
        parentToolCallId: row.parentToolCallId,
        status: row.status,
        taskPrompt: row.taskPrompt,
        taskResult: row.taskResult,
        taskStatus: row.taskStatus,
        usageRows: Number(row.usageRows),
      })),
      generationRunIds: [...new Set(rows.map((row) => row.generationRunId))].sort(),
      latestHostError: hostRows[0]?.error ?? null,
      latestHostGenerationRunId: hostRows[0]?.generationRunId ?? 'missing',
      latestHostRunId: hostRows[0]?.id ?? 'missing',
      latestHostStatus: hostRows[0]?.status ?? 'missing',
      nativeRunCount,
      parentMessageCount: Number(rows[0]?.parentMessageCount ?? 0),
      parentResultSlots,
      terminalEvents,
      workspaceReadCompletions: effectCount,
    };
  });
}
