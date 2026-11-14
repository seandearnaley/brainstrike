/**
 * The part of a compaction the host writes from the committed log, with no
 * model involved (BST-2527): the person's own request of each turn it covers
 * whole, every file the covered tool calls edited, and the tools they loaded.
 * It is derived for everything the compaction covers each time, so a merged
 * summary never depends on a model carrying it forward.
 */
import { committedRowAddress } from './committed-identities.ts';
import { committedTranscript } from './committed-transcript.ts';
import type { HostCompactionCuts } from './compaction-segments.ts';
import type { HostRunState } from './core-state.ts';
import type { HostToolDiscovery } from './ports.ts';
import type { HostEvent, HostLogRow } from './protocol.ts';
import { hostCompactedRows } from './run-history.ts';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

/** What the host lists in a compaction beside the model's summary. */
export type HostCompactionLedger = Pick<
  Compacted,
  'earlierRequests' | 'filesEdited' | 'toolsLoaded'
>;

/**
 * One request is cut at this many characters. The longest prompt of any eval
 * task (packages/agent-evals/tasks) is 639 characters, so an ordinary request
 * stays whole; a pasted log or file does not.
 */
const REQUEST_MAX_CHARS = 1000;
/**
 * The requests kept, newest first, stay within this many characters. The
 * longest eval thread's eight prompts total 1,293, so they stay whole; at
 * least three cut requests fit. About 1,000 estimated tokens.
 */
const REQUESTS_MAX_CHARS = 4000;
const CUT_MARKER = ' [truncated]';

/** The request up to `REQUEST_MAX_CHARS` characters, never inside one, then the marker. */
function cut(request: string): string {
  const characters = Array.from(request);
  return characters.length <= REQUEST_MAX_CHARS
    ? request
    : `${characters.slice(0, REQUEST_MAX_CHARS).join('')}${CUT_MARKER}`;
}

/**
 * The person's own request of each run `runs` names, oldest first, word for
 * word up to the cut. Only the person's words are a request (ADR-0028 rule
 * 2): never a delegation's task, a wake's delivery or a host continuation.
 * When they pass `REQUESTS_MAX_CHARS`, the newest are kept.
 */
export function compactedRequests(
  chain: readonly HostRunState[],
  runs: ReadonlySet<string>
): string[] {
  const requests = chain.flatMap(({ branch, id }) =>
    runs.has(id) && branch.author === 'person' && branch.prompt ? [cut(branch.prompt)] : []
  );
  let total = 0;
  let first = requests.length;
  while (first > 0 && total + (requests[first - 1]?.length ?? 0) <= REQUESTS_MAX_CHARS) {
    first -= 1;
    total += requests[first]?.length ?? 0;
  }
  return requests.slice(first);
}

/** A call's key in its run: SDK call ids are a run's own. */
function callKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

/** Every path the covered calls edited, with how many edits each made, in the order first edited. */
function editedFiles(
  rows: readonly HostLogRow[],
  calls: ReadonlySet<string>
): Compacted['filesEdited'] {
  const edits = new Map<string, number>();
  for (const { event } of rows) {
    if (
      event.type === 'workspace.edit.recorded' &&
      calls.has(callKey(event.runId, event.toolCallId))
    ) {
      edits.set(event.path, (edits.get(event.path) ?? 0) + 1);
    }
  }
  return [...edits].map(([path, count]) => ({ edits: count, path }));
}

/**
 * What the log holds for everything `covered` takes out of the run's
 * requests: each whole turn's request, the files its calls edited and the
 * tools its steps loaded, as the run's own discovery reads its loads.
 */
export async function hostCompactionLedger(
  input: {
    readonly chain: readonly HostRunState[];
    readonly discovery: Pick<HostToolDiscovery, 'loadedTools'> | undefined;
    /** The thread's committed rows. */
    readonly rows: readonly HostLogRow[];
  },
  covered: HostCompactionCuts
): Promise<HostCompactionLedger> {
  const run = input.chain.at(-1);
  if (!run) {
    throw new Error('A compaction ledger needs the run whose branch it covers');
  }
  const compacted = hostCompactedRows(
    input.rows,
    { runId: run.id, threadId: run.threadId },
    covered
  );
  const runOf = new Map(
    compacted.flatMap((row) =>
      'runId' in row.event ? [[committedRowAddress(row), row.event.runId] as const] : []
    )
  );
  const messages = committedTranscript(input.rows).filter((message) => runOf.has(message.id));
  const calls = new Set(
    messages.flatMap((message) =>
      message.content.parts.flatMap((part) =>
        part.type === 'tool-invocation'
          ? [callKey(runOf.get(message.id) ?? '', part.toolInvocation.toolCallId)]
          : []
      )
    )
  );
  return {
    earlierRequests: compactedRequests(input.chain, covered.runs),
    // An edit belongs to the call that made it, wherever its row landed.
    filesEdited: editedFiles(input.rows, calls),
    toolsLoaded: (await input.discovery?.loadedTools(messages)) ?? [],
  };
}
