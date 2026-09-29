/**
 * Which database snapshots to keep (BST-1877).
 *
 * A pure planner: it reads a snapshot inventory and returns what to keep and
 * what to prune, and never touches the disk. The store deletes exactly what the
 * plan names, after a snapshot is published. It reads no clock: the same
 * inventory always gives the same plan.
 *
 * The daily and weekly rules are restic's `forget` policy (restic.readthedocs.io,
 * "Removing snapshots according to a policy"): `--keep-daily n` keeps, for the
 * last n days THAT HAVE snapshots, only the last snapshot of each such day, and
 * `--keep-weekly n` does the same over ISO weeks. A gap in the history therefore
 * never shortens what is kept, and a calendar window relative to today is
 * never used. Days and weeks are UTC (restic uses local time; a snapshot
 * inventory that travels between machines must bucket identically). A snapshot
 * any rule keeps is kept, as in restic. The rules, in order:
 * 1. Never pruned: every protected id (the snapshot just published, anything a
 *    swap journal names) and the newest verified snapshot.
 * 2. `pre-migration` + `pre-update` together, and `pre-repair` + `post-repair`
 *    together, keep the newest N of their group.
 * 3. `daily` snapshots follow keep-daily and keep-weekly above. `manual` and
 *    `imported` are never pruned by a rule.
 * 4. The size cap counts LOGICAL bytes of what the rules kept. It prunes the
 *    oldest automatic, unpinned snapshots first, stops as soon as the total
 *    fits, and names the rules each such prune overrode. Whatever it cannot
 *    satisfy is reported as `overCap` and `overCapBytes`, never forced.
 */
import type { DatabaseSnapshotReason } from './database-snapshot-manifest.js';

export interface RetentionSnapshot {
  readonly byteSize: number;
  readonly createdAt: string;
  readonly id: string;
  readonly reason: DatabaseSnapshotReason;
  readonly verified: boolean;
}

export interface SnapshotRetentionPolicy {
  /** Logical bytes across every kept snapshot. */
  readonly capBytes: number;
  /** restic keep-daily: the last N days that have a `daily` snapshot. */
  readonly daily: number;
  /** Newest `pre-migration` + `pre-update` snapshots kept together. */
  readonly preUpdate: number;
  /** Newest `pre-repair` + `post-repair` snapshots kept together. */
  readonly repair: number;
  /** restic keep-weekly: the last N ISO weeks that have a `daily` snapshot. */
  readonly weekly: number;
}

export type RetentionRule = 'pre-update' | 'repair' | 'daily' | 'weekly';

export type SnapshotPrune =
  | { readonly id: string; readonly why: 'bucket' }
  /** The cap deleted a snapshot these rules would have kept. */
  | { readonly id: string; readonly overrides: readonly RetentionRule[]; readonly why: 'size-cap' };

export interface SnapshotRetentionPlan {
  /** Ids to keep, newest first. */
  readonly keep: readonly string[];
  /** The kept snapshots still exceed `capBytes` and none of the excess may be pruned. */
  readonly overCap: boolean;
  /** How many logical bytes above `capBytes` the plan leaves; 0 when the cap is met. */
  readonly overCapBytes: number;
  /** Ids to delete: bucket prunes newest first, then size-cap prunes oldest first. */
  readonly prune: readonly SnapshotPrune[];
}

export const DEFAULT_SNAPSHOT_RETENTION_POLICY: SnapshotRetentionPolicy = {
  capBytes: 20 * 1024 ** 3,
  daily: 7,
  preUpdate: 3,
  repair: 3,
  weekly: 4,
};

const DAY_MS = 86_400_000;
const RULE_ORDER: readonly RetentionRule[] = ['pre-update', 'repair', 'daily', 'weekly'];
type Reasons = ReadonlySet<DatabaseSnapshotReason>;
const DAILY_REASONS: Reasons = new Set(['daily']);
const PRE_UPDATE_REASONS: Reasons = new Set(['pre-migration', 'pre-update']);
const REPAIR_REASONS: Reasons = new Set(['pre-repair', 'post-repair']);
const NEVER_AUTOMATICALLY_PRUNED: Reasons = new Set(['manual', 'imported']);

interface Entry {
  readonly snapshot: RetentionSnapshot;
  readonly time: number;
}

function assertPolicy(policy: SnapshotRetentionPolicy): void {
  for (const key of ['daily', 'preUpdate', 'repair', 'weekly'] as const) {
    if (!Number.isInteger(policy[key]) || policy[key] < 0) {
      throw new RangeError(`Snapshot retention policy ${key} must be a non-negative integer.`);
    }
  }
  if (!Number.isFinite(policy.capBytes) || policy.capBytes < 0) {
    throw new RangeError(
      'Snapshot retention policy capBytes must be a non-negative finite number.'
    );
  }
}

/** 00:00 UTC of the day containing `time`. */
const utcDayStart = (time: number): number => Math.floor(time / DAY_MS) * DAY_MS;

/** Monday 00:00 UTC of the ISO week containing `time`. */
function isoWeekStart(time: number): number {
  const day = utcDayStart(time);
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
}

/**
 * The planner is an exported API, so it validates its own input rather than
 * trusting a caller to have parsed a manifest: `createdAt` is exactly what
 * `toISOString` writes (the manifest's own rule) and `byteSize` a finite,
 * non-negative integer, or the plan's ages and totals would be guesses.
 */
function toEntry(snapshot: RetentionSnapshot): Entry {
  const time = Date.parse(snapshot.createdAt);
  if (Number.isNaN(time) || new Date(time).toISOString() !== snapshot.createdAt) {
    throw new TypeError(
      `Snapshot "${snapshot.id}" has an invalid createdAt "${snapshot.createdAt}"; expected an ISO-8601 UTC timestamp as toISOString writes it.`
    );
  }
  if (!Number.isInteger(snapshot.byteSize) || snapshot.byteSize < 0) {
    throw new RangeError(
      `Snapshot "${snapshot.id}" has an invalid byteSize ${String(snapshot.byteSize)}; expected a finite non-negative integer.`
    );
  }
  return { snapshot, time };
}

/**
 * Ids are the directory names the manifest allows, which are ASCII, so ordering
 * by UTF-16 unit is ordering by code point; unlike `localeCompare` it never
 * depends on the runtime's ICU data.
 */
const compareIds = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

/** The ids of the entries `test` accepts, in order, in one pass. */
function idsWhere(entries: readonly Entry[], test: (id: string) => boolean): string[] {
  const ids: string[] = [];
  for (const { snapshot } of entries) {
    if (test(snapshot.id)) {
      ids.push(snapshot.id);
    }
  }
  return ids;
}

/** restic's keep-N-per-period: the newest entry of each of the `count` most recent periods that have one. `entries` is newest first. */
function newestOfRecentPeriods(
  entries: readonly Entry[],
  count: number,
  periodStart: (time: number) => number
): readonly Entry[] {
  const newestByPeriod = new Map<number, Entry>();
  for (const entry of entries) {
    const period = periodStart(entry.time);
    if (!newestByPeriod.has(period)) {
      newestByPeriod.set(period, entry);
    }
  }
  return [...newestByPeriod.entries()]
    .sort(([a], [b]) => b - a)
    .slice(0, count)
    .map(([, entry]) => entry);
}

export function planSnapshotRetention(input: {
  readonly policy?: SnapshotRetentionPolicy;
  readonly protectedIds: ReadonlySet<string>;
  readonly snapshots: readonly RetentionSnapshot[];
}): SnapshotRetentionPlan {
  const policy = input.policy ?? DEFAULT_SNAPSHOT_RETENTION_POLICY;
  assertPolicy(policy);
  const seen = new Set<string>();
  for (const { id } of input.snapshots) {
    if (seen.has(id)) {
      throw new Error(`Duplicate snapshot id "${id}" in the retention input.`);
    }
    seen.add(id);
  }
  // Newest first; an equal timestamp breaks on id so the plan is deterministic.
  const entries = input.snapshots
    .map(toEntry)
    .sort((a, b) => b.time - a.time || compareIds(b.snapshot.id, a.snapshot.id));

  const pinned = new Set(idsWhere(entries, (id) => input.protectedIds.has(id)));
  const newestVerified = entries.find(({ snapshot }) => snapshot.verified);
  if (newestVerified) {
    pinned.add(newestVerified.snapshot.id);
  }

  const withReason = (reasons: Reasons): readonly Entry[] =>
    entries.filter(({ snapshot }) => reasons.has(snapshot.reason));
  const dailies = withReason(DAILY_REASONS);
  const keptBy = new Map<string, Set<RetentionRule>>();
  const keepFor = (rule: RetentionRule, kept: readonly Entry[]): void => {
    for (const { snapshot } of kept) {
      keptBy.set(snapshot.id, (keptBy.get(snapshot.id) ?? new Set()).add(rule));
    }
  };
  keepFor('pre-update', withReason(PRE_UPDATE_REASONS).slice(0, policy.preUpdate));
  keepFor('repair', withReason(REPAIR_REASONS).slice(0, policy.repair));
  keepFor('daily', newestOfRecentPeriods(dailies, policy.daily, utcDayStart));
  keepFor('weekly', newestOfRecentPeriods(dailies, policy.weekly, isoWeekStart));

  const keep = new Set([
    ...pinned,
    ...keptBy.keys(),
    ...withReason(NEVER_AUTOMATICALLY_PRUNED).map(({ snapshot }) => snapshot.id),
  ]);
  const prune: SnapshotPrune[] = idsWhere(entries, (id) => !keep.has(id)).map((id) => ({
    id,
    why: 'bucket',
  }));

  let keptBytes = entries.reduce(
    (total, { snapshot }) => (keep.has(snapshot.id) ? total + snapshot.byteSize : total),
    0
  );
  const capCandidates = entries
    .filter(({ snapshot }) => keptBy.has(snapshot.id) && !pinned.has(snapshot.id))
    .reverse();
  for (const { snapshot } of capCandidates) {
    if (keptBytes <= policy.capBytes) {
      break;
    }
    keep.delete(snapshot.id);
    const rules = keptBy.get(snapshot.id) ?? new Set<RetentionRule>();
    prune.push({
      id: snapshot.id,
      overrides: RULE_ORDER.filter((rule) => rules.has(rule)),
      why: 'size-cap',
    });
    keptBytes -= snapshot.byteSize;
  }

  return {
    keep: idsWhere(entries, (id) => keep.has(id)),
    overCap: keptBytes > policy.capBytes,
    overCapBytes: Math.max(0, keptBytes - policy.capBytes),
    prune,
  };
}
