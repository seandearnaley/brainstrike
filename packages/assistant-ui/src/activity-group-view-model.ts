import { type ActivityStep, stepVerbText } from './activity-trace-model';
import { type ActivityVerb, VERB_FAMILIES, type VerbFamily } from './activity-verbs';

/**
 * How one activity group lays out a long run (activity trace at scale): folded
 * clusters of repeated work, family filters, the live tail under a running
 * header and the run strip beside it. Pure derivations over the group's
 * `deriveActivitySteps` list, so every surface reads one answer.
 */

/** Fewest consecutive same-verb steps that fold into one cluster row. */
export const CLUSTER_MIN_STEPS = 3;
/** Fewest tool steps before the group body offers family filters. */
export const FILTER_MIN_STEPS = 20;
/** Fewest steps before the header carries a run strip. */
export const RUN_STRIP_MIN_STEPS = 8;
/** Most marks on the strip; a longer run is bucketed so the strip keeps its width. */
export const RUN_STRIP_MAX_MARKS = 80;
/** Settled steps the live tail keeps under a running header. */
export const LIVE_TAIL_SIZE = 3;

/**
 * Families never folded: a question, plan, canvas, task list or delegation is
 * something a person reads or answers on its own card.
 */
const UNFOLDABLE_FAMILIES: ReadonlySet<VerbFamily> = new Set([
  'ask',
  'canvas',
  'delegate',
  'tasks',
]);

export interface ActivityCluster {
  /** Total execution time, when every member reports one. */
  readonly durationMs: number | undefined;
  /** The first member's step id; stable while the run grows. */
  readonly id: string;
  /** "Read 12 files", "Ran 4 commands", "Searched 5 times". */
  readonly label: string;
  readonly memberIds: readonly string[];
  /** Distinct targets beyond the preview. */
  readonly morePreview: number;
  /** Up to three distinct member targets, in run order. */
  readonly preview: readonly string[];
  readonly verb: ActivityVerb;
}

function isFoldable(step: ActivityStep, unfoldable: ReadonlySet<string>): boolean {
  return (
    step.kind === 'tool' &&
    step.state === 'done' &&
    !UNFOLDABLE_FAMILIES.has(step.verb.family) &&
    !unfoldable.has(step.id)
  );
}

function sameVerb(a: ActivityVerb, b: ActivityVerb): boolean {
  return a.done === b.done && a.family === b.family;
}

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function clusterLabel(verb: ActivityVerb, members: readonly ActivityStep[]): string {
  if (verb.countsFiles) {
    const files = new Set(members.map((step) => step.targetKey ?? step.id)).size;
    return `${verb.done} ${counted(files, 'file')}`;
  }
  if (verb.family === 'run' && verb.done === 'Ran') {
    return `${verb.done} ${counted(members.length, 'command')}`;
  }
  return `${verb.done} ${members.length} times`;
}

function toCluster(members: readonly ActivityStep[]): ActivityCluster {
  const [first] = members;
  if (!first) {
    throw new Error('A cluster has at least one member.');
  }
  const names: string[] = [];
  for (const step of members) {
    const name = first.verb.countsFiles && step.targetKey ? basename(step.targetKey) : step.target;
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  const durations = members.map((step) => step.durationMs);
  return {
    durationMs: durations.every((ms) => ms !== undefined)
      ? durations.reduce<number>((total, ms) => total + (ms ?? 0), 0)
      : undefined,
    id: first.id,
    label: clusterLabel(first.verb, members),
    memberIds: members.map((step) => step.id),
    morePreview: Math.max(0, names.length - 3),
    preview: names.slice(0, 3),
    verb: first.verb,
  };
}

/**
 * Runs of at least {@link CLUSTER_MIN_STEPS} consecutive settled tool steps
 * with the same verb. A failed, cancelled, running or waiting step never
 * folds, and neither does readable reasoning between two calls: each ends the
 * run, so a failure always stands on its own row in chronological order.
 * `unfoldable` names steps whose card must stay mounted (approval-bearing
 * calls, results with their own renderer such as MCP apps).
 */
export function deriveActivityClusters(
  steps: readonly ActivityStep[],
  unfoldable: ReadonlySet<string>
): readonly ActivityCluster[] {
  const clusters: ActivityCluster[] = [];
  let run: ActivityStep[] = [];
  const close = (): void => {
    if (run.length >= CLUSTER_MIN_STEPS) {
      clusters.push(toCluster(run));
    }
    run = [];
  };
  for (const step of steps) {
    if (!isFoldable(step, unfoldable)) {
      close();
      continue;
    }
    const [head] = run;
    if (head && !sameVerb(head.verb, step.verb)) {
      close();
    }
    run.push(step);
  }
  close();
  return clusters;
}

/** `all`, failed steps only, or one verb family. */
export type ActivityFilter = 'all' | 'failed' | VerbFamily;

export interface ActivityFilterOption {
  readonly count: number;
  readonly filter: ActivityFilter;
  readonly label: string;
}

const FAMILY_FILTER_LABELS: Readonly<Record<VerbFamily, string>> = {
  ask: 'Questions',
  call: 'MCP calls',
  canvas: 'Canvas',
  delegate: 'Delegations',
  edit: 'Edits',
  memory: 'Memory',
  other: 'Other',
  read: 'Reads',
  run: 'Commands',
  search: 'Searches',
  skill: 'Skills',
  tasks: 'Tasks',
  tools: 'Tool discovery',
  web: 'Web',
  worktree: 'Worktrees',
};

/**
 * The filter bar's options, or none below {@link FILTER_MIN_STEPS} tool
 * steps: All, each family present (in `VERB_FAMILIES` order), then Failed
 * when any step failed.
 */
export function activityFilterOptions(
  steps: readonly ActivityStep[]
): readonly ActivityFilterOption[] {
  const tools = steps.filter((step) => step.kind === 'tool');
  if (tools.length < FILTER_MIN_STEPS) {
    return [];
  }
  const families = VERB_FAMILIES.flatMap((family) => {
    const count = tools.filter((step) => step.verb.family === family).length;
    return count > 0 ? [{ count, filter: family, label: FAMILY_FILTER_LABELS[family] }] : [];
  });
  const failed = tools.filter((step) => step.state === 'failed').length;
  return [
    { count: tools.length, filter: 'all', label: 'All' },
    ...families,
    ...(failed > 0 ? [{ count: failed, filter: 'failed' as const, label: 'Failed' }] : []),
  ];
}

/** Whether a step shows under a filter; reasoning shows only under All. */
export function matchesActivityFilter(step: ActivityStep, filter: ActivityFilter): boolean {
  if (filter === 'all') {
    return true;
  }
  if (step.kind !== 'tool') {
    return false;
  }
  return filter === 'failed' ? step.state === 'failed' : step.verb.family === filter;
}

export interface ActivityTailEntry {
  readonly family: VerbFamily;
  readonly id: string;
  readonly state: 'cancelled' | 'done' | 'failed';
  readonly target: string | null;
  readonly verb: string;
}

/**
 * The newest settled tool steps, oldest first, for the lines under a running
 * header. The step still running is the header's own label, never a tail line.
 */
export function deriveLiveTail(steps: readonly ActivityStep[]): readonly ActivityTailEntry[] {
  const settled: ActivityTailEntry[] = [];
  for (const step of steps) {
    if (
      step.kind === 'tool' &&
      (step.state === 'done' || step.state === 'failed' || step.state === 'cancelled')
    ) {
      settled.push({
        family: step.verb.family,
        id: step.id,
        state: step.state,
        target: step.verb.namesTool ? null : step.target,
        verb: stepVerbText(step.verb, step.state, step.ran),
      });
    }
  }
  return settled.slice(-LIVE_TAIL_SIZE);
}

/** What one strip mark shows: a family, a readable thought, or a state that outranks both. */
export type RunStripMarkKind = VerbFamily | 'failed' | 'running' | 'thought' | 'waiting';

export interface RunStripMark {
  readonly kind: RunStripMarkKind;
  /** Hover text: the step it stands for, or the span it summarizes. */
  readonly label: string;
  /** The step a click opens: the bucket's failure first, else its first step. */
  readonly stepId: string;
}

function markKind(step: ActivityStep): RunStripMarkKind {
  if (step.state === 'failed' || step.state === 'running' || step.state === 'waiting') {
    return step.state;
  }
  return step.kind === 'reasoning' ? 'thought' : step.verb.family;
}

const MARK_PRECEDENCE: readonly RunStripMarkKind[] = ['failed', 'waiting', 'running'];

function stepLabel(step: ActivityStep): string {
  const verb = stepVerbText(step.verb, step.state, step.ran);
  return step.target ? `${verb} ${step.target}` : verb;
}

/**
 * One mark per step, or per bucket of steps once the run is longer than
 * {@link RUN_STRIP_MAX_MARKS}. A bucket shows a failure, a pause or live work
 * when it holds one; otherwise its most frequent family. None below
 * {@link RUN_STRIP_MIN_STEPS} steps.
 */
export function deriveRunStrip(steps: readonly ActivityStep[]): readonly RunStripMark[] {
  if (steps.length < RUN_STRIP_MIN_STEPS) {
    return [];
  }
  const size = Math.ceil(steps.length / RUN_STRIP_MAX_MARKS);
  const marks: RunStripMark[] = [];
  for (let start = 0; start < steps.length; start += size) {
    const bucket = steps.slice(start, start + size);
    const [first] = bucket;
    if (!first) {
      continue;
    }
    const kinds = bucket.map(markKind);
    const urgent = MARK_PRECEDENCE.find((kind) => kinds.includes(kind));
    const tally = new Map<RunStripMarkKind, number>();
    for (const kind of kinds) {
      tally.set(kind, (tally.get(kind) ?? 0) + 1);
    }
    const common = [...tally.entries()].reduce((best, entry) =>
      entry[1] > best[1] ? entry : best
    );
    const kind = urgent ?? common[0];
    const lead = urgent ? (bucket.find((step) => markKind(step) === urgent) ?? first) : first;
    marks.push({
      kind,
      label: bucket.length === 1 ? stepLabel(first) : `${stepLabel(lead)} · ${bucket.length} steps`,
      stepId: lead.id,
    });
  }
  return marks;
}
