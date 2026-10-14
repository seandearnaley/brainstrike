import type { HostClient } from '@brainstrike/agent-host/browser';
import { readDesktopRunConfiguration } from '@brainstrike/agent-host/desktop-run-configuration';
import {
  catalogModel,
  observerUsageModel,
  STATUS_BY_OUTCOME,
  tokensOf,
} from '@brainstrike/agent-host/ledger-projection';
import type { HostEvent, HostLogRow } from '@brainstrike/agent-host/protocol';
import {
  buildHostThreadDebugPack,
  collectCorrelatedDiagnostics,
  type DebugBundleDiagnosticsReader,
  formatThreadDebugBundle,
  type HostThreadDebugSnapshot,
  readDebugBundleEnvironment,
  readThreadDebugHostProbe,
  type ThreadDebugBundleData,
} from '@brainstrike/app-shell';
import type { DebugBundleBinding } from '@brainstrike/assistant-ui';
import { z } from 'zod';

type HostReader = Pick<HostClient, 'request'>;
type BundleRun = NonNullable<ThreadDebugBundleData['run']>;
type RunStarted = Extract<HostEvent, { type: 'run.started' }>;

/** The legacy bundle's bounds: its newest 40 transcript messages and 500 timeline events. */
const TRANSCRIPT_MESSAGES = 40;
const TIMELINE_EVENTS = 500;

/** AI SDK response messages, as a model.step commits them. */
const StepMessageSchema = z.object({ content: z.json(), role: z.string() });

function iso(row: HostLogRow): string {
  return row.ts === undefined ? '(commit time not recorded)' : new Date(row.ts).toISOString();
}

function runIdOf(event: HostEvent): string | undefined {
  return 'runId' in event ? event.runId : undefined;
}

/** The selected run, else the latest failed run, else the latest run (the legacy order). */
function selectRun(
  rows: readonly HostLogRow[],
  runId: string | null
): { finished: HostLogRow | undefined; started: HostLogRow & { event: RunStarted } } | undefined {
  const starts = rows.filter(
    (row): row is HostLogRow & { event: RunStarted } => row.event.type === 'run.started'
  );
  const finishOf = (id: string) =>
    rows.findLast((row) => row.event.type === 'run.finished' && row.event.runId === id);
  const pick = (started: HostLogRow & { event: RunStarted }) => ({
    finished: finishOf(started.event.runId),
    started,
  });
  if (runId !== null) {
    const started = starts.find((row) => row.event.runId === runId);
    return started ? pick(started) : undefined;
  }
  const failed = starts.findLast((row) => {
    const finished = finishOf(row.event.runId);
    return (
      finished?.event.type === 'run.finished' &&
      STATUS_BY_OUTCOME[finished.event.outcome] === 'failed'
    );
  });
  const latest = failed ?? starts.at(-1);
  return latest ? pick(latest) : undefined;
}

function bundleRun(
  started: HostLogRow & { event: RunStarted },
  finished: HostLogRow | undefined
): BundleRun {
  const model = catalogModel(started.event.modelId);
  const generation = readDesktopRunConfiguration(started.event)?.intent?.modelConfiguration;
  const outcome = finished?.event.type === 'run.finished' ? finished.event : undefined;
  return {
    completedAt: finished ? iso(finished) : null,
    error: outcome && outcome.outcome !== 'completed' ? (outcome.detail ?? outcome.outcome) : null,
    id: started.event.runId,
    model: model?.model ?? started.event.modelId,
    modelSettings: generation?.modelSettings ?? null,
    provider: model?.provider ?? '(not a catalog model)',
    providerOptions: generation?.providerOptions ?? null,
    runtimeKind: 'agent-host',
    startedAt: iso(started),
    status: outcome ? STATUS_BY_OUTCOME[outcome.outcome] : 'running',
  };
}

/** The run's committed rows, minus the streamed output and step messages the transcript holds. */
function timeline(rows: readonly HostLogRow[], runId: string): ThreadDebugBundleData['runEvents'] {
  return rows
    .filter(
      (row) =>
        runIdOf(row.event) === runId &&
        row.event.type !== 'stream.chunk' &&
        row.event.type !== 'model.messages'
    )
    .slice(0, TIMELINE_EVENTS)
    .map((row) => {
      const { type, ...payload } = row.event;
      const metadata =
        row.event.type === 'model.step'
          ? { model: row.event.model, stepNumber: row.event.stepNumber, usage: row.event.usage }
          : payload;
      return {
        detail:
          'detail' in row.event && typeof row.event.detail === 'string' ? row.event.detail : null,
        durationMs: null,
        kind: type,
        label: null,
        metadata,
        occurredAt: iso(row),
        sequence: row.seq,
        status:
          row.event.type === 'run.finished'
            ? row.event.outcome
            : row.event.type === 'run.attempt'
              ? row.event.recovered
                ? 'recovered'
                : 'refused'
              : null,
      };
    });
}

/** Each run's prompt and each provider step's response messages, newest 40, oldest first. */
function transcript(rows: readonly HostLogRow[]): ThreadDebugBundleData['messages'] {
  const messages = rows.flatMap((row): ThreadDebugBundleData['messages'] => {
    if (row.event.type === 'run.started') {
      return [
        {
          content: row.event.prompt,
          createdAt: iso(row),
          id: row.event.userMessageId ?? `${row.event.runId}/prompt`,
          role: 'user',
        },
      ];
    }
    if (row.event.type !== 'model.step') {
      return [];
    }
    const { runId, stepNumber } = row.event;
    return row.event.messages.map((message, index) => {
      const parsed = StepMessageSchema.safeParse(message);
      return {
        content: parsed.success ? parsed.data.content : message,
        createdAt: iso(row),
        id: `${runId}/step-${stepNumber}/${index}`,
        role: parsed.success ? parsed.data.role : '(unrecognized message)',
      };
    });
  });
  return messages.slice(-TRANSCRIPT_MESSAGES);
}

/** The run's provider calls; an observer call whose id names no provider says so. */
function usage(
  rows: readonly HostLogRow[],
  run: HostLogRow & { event: RunStarted }
): ThreadDebugBundleData['usage'] {
  const runModel = catalogModel(run.event.modelId);
  return rows.flatMap((row): ThreadDebugBundleData['usage'] => {
    const { event } = row;
    if (runIdOf(event) !== run.event.runId) {
      return [];
    }
    const call =
      event.type === 'model.step'
        ? { model: runModel, modelId: run.event.modelId, usage: event.usage }
        : event.type === 'memory.usage'
          ? {
              model: observerUsageModel(event.modelId),
              modelId: event.modelId,
              usage: event.usage,
            }
          : event.type === 'context.compacted' && event.usage !== undefined
            ? {
                model: catalogModel(event.modelId ?? run.event.modelId),
                modelId: event.modelId ?? run.event.modelId,
                usage: event.usage,
              }
            : undefined;
    if (!call) {
      return [];
    }
    const tokens = tokensOf(call.usage);
    return [
      {
        billedCostUsd: null,
        inputTokens: tokens.inputTokens,
        model: call.model?.model ?? call.modelId,
        outputTokens: tokens.outputTokens,
        provider: call.model?.provider ?? '(unattributed)',
      },
    ];
  });
}

/**
 * The legacy debug bundle's run, timeline, transcript and usage, read from a
 * host thread's committed log. The host commits no provider error record, so
 * `runError` is absent and the run's finish detail is its error.
 */
export function collectHostThreadDebugBundleData(
  rows: readonly HostLogRow[],
  input: { readonly runId: string | null; readonly threadId: string }
): Omit<ThreadDebugBundleData, 'diagnosticEvents' | 'environment' | 'priorFailures'> {
  const selected = selectRun(rows, input.runId);
  return {
    messages: transcript(rows),
    run: selected ? bundleRun(selected.started, selected.finished) : null,
    runError: null,
    runEvents: selected ? timeline(rows, selected.started.event.runId) : [],
    threadId: input.threadId,
    usage: selected ? usage(rows, selected.started) : [],
  };
}

async function readRows(host: HostReader, threadId: string): Promise<readonly HostLogRow[]> {
  return (await host.request('thread/read', { fromSeq: 0, threadId })).rows;
}

/** The conversation's log and its delegated descendants', read from the host. */
export async function readHostThreadDebugSnapshot(
  host: HostReader,
  rootThreadId: string
): Promise<HostThreadDebugSnapshot> {
  const threads: HostThreadDebugSnapshot['threads'][number][] = [];
  const all: HostLogRow[] = [];
  const queue: { parentThreadId: string | null; threadId: string }[] = [
    { parentThreadId: null, threadId: rootThreadId },
  ];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { parentThreadId, threadId } = next;
    const [rows, { children }] = await Promise.all([
      readRows(host, threadId),
      host.request('thread/children', { threadId }),
    ]);
    threads.push({ parentThreadId, rows, threadId });
    all.push(...rows);
    queue.push(
      ...children.map((child) => ({ parentThreadId: threadId, threadId: child.threadId }))
    );
  }
  const finished = new Set(
    all.flatMap((row) => (row.event.type === 'run.finished' ? [row.event.runId] : []))
  );
  const starts = all.filter((row) => row.event.type === 'run.started');
  const startTimes = starts.flatMap((row) => (row.ts === undefined ? [] : [row.ts]));
  return {
    activeRunIds: starts.flatMap((row) =>
      row.event.type === 'run.started' && !finished.has(row.event.runId) ? [row.event.runId] : []
    ),
    capturedAt: new Date().toISOString(),
    earliestRunStartMs: startTimes.length > 0 ? Math.min(...startTimes) : null,
    rootThreadId,
    threads,
  };
}

/**
 * The thread debug pack and Copy debug bundle for a host thread, built from
 * the host's committed log when asked. Correlated diagnostics come from the
 * Main's retained diagnostic log through its read-only capability.
 */
export function createHostDebugBundleBinding(
  host: HostReader,
  threadId: string,
  diagnostics: DebugBundleDiagnosticsReader
): DebugBundleBinding {
  return {
    buildBundle: async ({ runId }) => {
      const data = collectHostThreadDebugBundleData(await readRows(host, threadId), {
        runId,
        threadId,
      });
      return formatThreadDebugBundle({
        ...data,
        ...(await collectCorrelatedDiagnostics(diagnostics, { run: data.run, threadId })),
        environment: readDebugBundleEnvironment(),
      });
    },
    buildThreadPack: async () =>
      buildHostThreadDebugPack(
        await readHostThreadDebugSnapshot(host, threadId),
        readThreadDebugHostProbe()
      ),
  };
}
