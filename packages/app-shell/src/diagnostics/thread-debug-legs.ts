import type { ThreadDebugSnapshot } from '@brainstrike/db';

/**
 * Derived thread debug pack views (pure). Rows carry the snapshot's SQL column
 * names. A row missing an identity column the schema declares NOT NULL is a
 * broken snapshot, so derivation throws (the download fails visibly) rather
 * than silently dropping that leg or step.
 */
type Sections = ThreadDebugSnapshot['sections'];
type Row = Record<string, unknown>;

const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  'run.cancelled',
  'run.failed',
  'run.finished',
]);

export interface ThreadDebugLeg {
  readonly completedAt: string | null;
  readonly completionTokens: number | null;
  readonly finishReason: string | null;
  readonly kind: 'delegated' | 'root';
  /**
   * The last run.step.finished reason. A leg that ended paused (an approval or
   * question) has no terminal run event, so `finishReason` is null while this
   * still says why its final step stopped (live run 21, 2026-09-15).
   */
  readonly lastStepFinishReason: string | null;
  readonly lengthCutSteps: number;
  readonly model: string | null;
  readonly openRouterProviders: readonly string[];
  readonly personaId: string | null;
  readonly promptTokens: number | null;
  readonly provider: string | null;
  readonly runId: string;
  readonly startedAt: string | null;
  readonly status: string | null;
  readonly steps: number;
  readonly threadId: string;
}

export interface ThreadDebugChildFirstStep {
  /** The admitted child thread, or null when its invocation is outside this snapshot. */
  readonly childThreadId: string | null;
  readonly createdAt: string;
  readonly dispatchingThreadId: string;
  readonly manifestId: string;
  readonly nativeRunId: string;
  readonly parentToolCallId: string;
  readonly personaId: string | null;
  /** Later rows for the same dispatch address: a resumed child re-entering the start hook. */
  readonly reentryManifestIds: readonly string[];
}

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(row: Row, column: string, section: string): string {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Thread debug pack: ${section} row is missing ${column}.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface RunEvidence {
  lastStepFinishReason: string | null;
  lengthCutSteps: number;
  readonly openRouterProviders: Set<string>;
  steps: number;
  terminal: Row | null;
}

function collectRunEvidence(events: readonly Row[]): Map<string, RunEvidence> {
  const byRun = new Map<string, RunEvidence>();
  for (const event of events) {
    const runId = requireString(event, 'run_id', 'events');
    const kind = requireString(event, 'kind', 'events');
    const metadata = isRecord(event['metadata']) ? event['metadata'] : null;
    let evidence = byRun.get(runId);
    if (!evidence) {
      evidence = {
        lastStepFinishReason: null,
        lengthCutSteps: 0,
        openRouterProviders: new Set(),
        steps: 0,
        terminal: null,
      };
      byRun.set(runId, evidence);
    }
    const upstream = optionalString(metadata?.['openRouterProvider']);
    if (upstream) {
      evidence.openRouterProviders.add(upstream);
    }
    if (kind === 'run.step.finished') {
      evidence.steps += 1;
      evidence.lastStepFinishReason = optionalString(metadata?.['finishReason']);
      if (metadata?.['finishReason'] === 'length') {
        evidence.lengthCutSteps += 1;
      }
    }
    if (TERMINAL_KINDS.has(kind)) {
      evidence.terminal = metadata;
    }
  }
  return byRun;
}

/** Delegated (depth > 0) threads → the persona id of their admitted configuration. */
function readDelegatedThreads(conversations: readonly Row[]): Map<string, string | null> {
  const delegated = new Map<string, string | null>();
  for (const row of conversations) {
    const depth = row['delegation_depth'];
    if (typeof depth !== 'number') {
      throw new Error('Thread debug pack: conversations row is missing delegation_depth.');
    }
    if (depth === 0) {
      continue;
    }
    const configuration = row['configuration'];
    const persona = isRecord(configuration) ? configuration['persona'] : undefined;
    delegated.set(
      requireString(row, 'thread_id', 'conversations'),
      isRecord(persona) ? optionalString(persona['id']) : null
    );
  }
  return delegated;
}

/** One row per run: identity, model, upstreams seen, terminal reason, step counts. */
export function deriveThreadDebugLegs(sections: Sections): ThreadDebugLeg[] {
  const delegated = readDelegatedThreads(sections['conversations'] ?? []);
  const evidenceByRun = collectRunEvidence(sections['events'] ?? []);
  return (sections['runs'] ?? []).map((run) => {
    const runId = requireString(run, 'id', 'runs');
    const threadId = requireString(run, 'thread_id', 'runs');
    const evidence = evidenceByRun.get(runId);
    const terminal = evidence?.terminal ?? null;
    return {
      completedAt: optionalString(run['completed_at']),
      completionTokens: optionalNumber(terminal?.['completionTokens']),
      finishReason: optionalString(terminal?.['finishReason']),
      kind: delegated.has(threadId) ? 'delegated' : 'root',
      lastStepFinishReason: evidence?.lastStepFinishReason ?? null,
      lengthCutSteps: evidence?.lengthCutSteps ?? 0,
      model: optionalString(run['model']),
      openRouterProviders: [...(evidence?.openRouterProviders ?? [])].sort(),
      personaId: delegated.get(threadId) ?? null,
      promptTokens: optionalNumber(terminal?.['promptTokens']),
      provider: optionalString(run['provider']),
      runId,
      startedAt: optionalString(run['started_at']),
      status: optionalString(run['status']),
      steps: evidence?.steps ?? 0,
      threadId,
    };
  });
}

interface ManifestStamp {
  readonly at: number;
  readonly id: string;
  readonly row: Row;
}

function byTime(left: ManifestStamp, right: ManifestStamp): number {
  return left.at - right.at || left.id.localeCompare(right.id);
}

/**
 * The EARLIEST child-first-step manifest per dispatch address
 * (`native_run_id`, `parent_tool_call_id`). A parked child resumed on a new
 * leg re-enters the delegation start hook and records another row for the same
 * address; those are listed as re-entries, never as second dispatches.
 */
export function deriveChildFirstSteps(sections: Sections): ThreadDebugChildFirstStep[] {
  const childThreadByAddress = new Map<string, string>();
  for (const invocation of sections['invocations'] ?? []) {
    childThreadByAddress.set(
      JSON.stringify([
        requireString(invocation, 'parent_runtime_run_id', 'invocations'),
        requireString(invocation, 'parent_tool_call_id', 'invocations'),
      ]),
      requireString(invocation, 'thread_id', 'invocations')
    );
  }
  const stampsByAddress = new Map<string, ManifestStamp[]>();
  for (const row of sections['promptManifests'] ?? []) {
    if (row['kind'] !== 'child-first-step') {
      continue;
    }
    const id = requireString(row, 'id', 'promptManifests');
    const address = JSON.stringify([
      requireString(row, 'native_run_id', 'promptManifests'),
      requireString(row, 'parent_tool_call_id', 'promptManifests'),
    ]);
    const at = Date.parse(requireString(row, 'created_at', 'promptManifests'));
    if (Number.isNaN(at)) {
      throw new Error(
        `Thread debug pack: promptManifests row ${id} has an unparseable created_at.`
      );
    }
    stampsByAddress.set(address, [...(stampsByAddress.get(address) ?? []), { at, id, row }]);
  }
  return [...stampsByAddress]
    .map(([address, stamps]) => ({ address, stamps: [...stamps].sort(byTime) }))
    .sort((left, right) =>
      byTime(left.stamps[0] as ManifestStamp, right.stamps[0] as ManifestStamp)
    )
    .map(({ address, stamps }) => {
      const [first, ...reentries] = stamps as [ManifestStamp, ...ManifestStamp[]];
      return {
        childThreadId: childThreadByAddress.get(address) ?? null,
        createdAt: requireString(first.row, 'created_at', 'promptManifests'),
        dispatchingThreadId: requireString(first.row, 'thread_id', 'promptManifests'),
        manifestId: first.id,
        nativeRunId: requireString(first.row, 'native_run_id', 'promptManifests'),
        parentToolCallId: requireString(first.row, 'parent_tool_call_id', 'promptManifests'),
        personaId: optionalString(first.row['persona_id']),
        reentryManifestIds: reentries.map((stamp) => stamp.id),
      };
    });
}
