import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SNAPSHOT_RETENTION_POLICY,
  planSnapshotRetention,
  type RetentionSnapshot,
  type SnapshotRetentionPolicy,
} from '../src/snapshot-retention.js';

/** ISO weeks (Mon-Sun) used below: Sep 28-Oct 4, Sep 21-27, Sep 14-20, Sep 7-13, Aug 31-Sep 6, Aug 3-9, Jul 27-Aug 2. */
const MIB = 1024 * 1024;

function snapshot(
  id: string,
  reason: RetentionSnapshot['reason'],
  createdAt: string,
  overrides: Partial<Pick<RetentionSnapshot, 'byteSize' | 'verified'>> = {}
): RetentionSnapshot {
  return { byteSize: MIB, createdAt, id, reason, verified: true, ...overrides };
}

/** `count` snapshots of one reason, one per hour from `startHour` on Sep 29, named `<reason>-<n>`; the newest has the highest n. */
function series(
  reason: RetentionSnapshot['reason'],
  count: number,
  overrides: Partial<Pick<RetentionSnapshot, 'byteSize' | 'verified'>> & { startHour?: number } = {}
): RetentionSnapshot[] {
  const { startHour = 0, ...snapshotOverrides } = overrides;
  return Array.from({ length: count }, (_, index) =>
    snapshot(
      `${reason}-${index + 1}`,
      reason,
      new Date(Date.UTC(2026, 8, 29, startHour + index)).toISOString(),
      snapshotOverrides
    )
  );
}

/** One `daily` per listed UTC day at 03:00, id `d-<date>`. */
function dailiesOn(days: readonly string[], overrides: Partial<RetentionSnapshot> = {}) {
  return days.map((day) => snapshot(`d-${day}`, 'daily', `${day}T03:00:00.000Z`, overrides));
}

/** Every UTC day from `from` through `to`, inclusive, as `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = Date.parse(from); day <= Date.parse(to); day += 86_400_000) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
}

function plan(
  snapshots: readonly RetentionSnapshot[],
  options: { policy?: SnapshotRetentionPolicy; protectedIds?: readonly string[] } = {}
) {
  return planSnapshotRetention({
    policy: options.policy,
    protectedIds: new Set(options.protectedIds ?? []),
    snapshots,
  });
}

const prunedIds = (result: ReturnType<typeof plan>) => result.prune.map((entry) => entry.id).sort();

describe('planSnapshotRetention buckets', () => {
  it('keeps the newest 3 across pre-migration and pre-update together', () => {
    const snapshots = [
      snapshot('pre-update-1', 'pre-update', '2026-09-01T00:00:00.000Z'),
      snapshot('pre-migration-1', 'pre-migration', '2026-09-02T00:00:00.000Z'),
      snapshot('pre-update-2', 'pre-update', '2026-09-03T00:00:00.000Z'),
      snapshot('pre-migration-2', 'pre-migration', '2026-09-04T00:00:00.000Z'),
      snapshot('pre-update-3', 'pre-update', '2026-09-05T00:00:00.000Z'),
    ];
    const result = plan(snapshots);
    expect([...result.keep].sort()).toEqual(['pre-migration-2', 'pre-update-2', 'pre-update-3']);
    expect(result.prune).toEqual(
      expect.arrayContaining([
        { id: 'pre-update-1', why: 'bucket' },
        { id: 'pre-migration-1', why: 'bucket' },
      ])
    );
    expect(result.prune).toHaveLength(2);
    expect(result.overCap).toBe(false);
  });

  it('keeps the newest 3 across pre-repair and post-repair together', () => {
    const snapshots = [
      snapshot('pre-repair-1', 'pre-repair', '2026-09-01T00:00:00.000Z'),
      snapshot('post-repair-1', 'post-repair', '2026-09-02T00:00:00.000Z'),
      snapshot('pre-repair-2', 'pre-repair', '2026-09-03T00:00:00.000Z'),
      snapshot('post-repair-2', 'post-repair', '2026-09-04T00:00:00.000Z'),
    ];
    const result = plan(snapshots);
    expect(prunedIds(result)).toEqual(['pre-repair-1']);
    expect([...result.keep].sort()).toEqual(['post-repair-1', 'post-repair-2', 'pre-repair-2']);
  });

  it('keeps only the newest daily of each day, like restic keep-daily', () => {
    // Ten dailies inside one UTC day: only the day's newest is a candidate.
    const result = plan(series('daily', 10));
    expect(result.keep).toEqual(['daily-10']);
    expect(prunedIds(result)).toEqual(
      Array.from({ length: 9 }, (_, index) => `daily-${index + 1}`).sort()
    );
  });

  it('counts the last 7 days that HAVE snapshots, not calendar days, and the last 4 such ISO weeks', () => {
    const days = [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
    ];
    const result = plan(dailiesOn(days));
    // The 7 newest days with a snapshot (Sep 10-12, 20-23), plus the newest of each of the 4
    // most recent weeks that have one: Sep 21-27 (Sep 23), Sep 14-20 (Sep 20), Sep 7-13
    // (Sep 12) and Aug 3-9 (Aug 3), which lies far outside any calendar window.
    expect([...result.keep].sort()).toEqual(
      [
        'd-2026-08-03',
        'd-2026-09-10',
        'd-2026-09-11',
        'd-2026-09-12',
        'd-2026-09-20',
        'd-2026-09-21',
        'd-2026-09-22',
        'd-2026-09-23',
      ].sort()
    );
    expect(prunedIds(result)).toEqual(['d-2026-08-01', 'd-2026-08-02']);
  });

  it('promotes the newest daily of each recent ISO week beyond the last 7 days', () => {
    const result = plan(dailiesOn(daysBetween('2026-08-20', '2026-09-30')));
    const lastSevenDays = daysBetween('2026-09-24', '2026-09-30').map((day) => `d-${day}`);
    // Weeks Sep 14-20 and Sep 7-13 fall outside the last 7 days; their last daily is promoted.
    expect([...result.keep].sort()).toEqual(
      [...lastSevenDays, 'd-2026-09-13', 'd-2026-09-20'].sort()
    );
    expect(result.prune.every((entry) => entry.why === 'bucket')).toBe(true);
    // A fifth week (Aug 31-Sep 6) is beyond the four: nothing there is promoted.
    expect(prunedIds(result)).toContain('d-2026-09-06');
    expect(prunedIds(result)).not.toContain('d-2026-09-13');
  });

  it('does not depend on the clock: the same inventory gives the same plan', () => {
    const inventory = dailiesOn(daysBetween('2026-08-20', '2026-09-30'));
    expect(plan(inventory)).toEqual(plan([...inventory].reverse()));
  });

  it('never prunes manual or imported snapshots by bucket', () => {
    const snapshots = [...series('manual', 12), ...series('imported', 12)];
    const result = plan(snapshots);
    expect(result.prune).toEqual([]);
    expect(result.keep).toHaveLength(24);
  });

  it('keeps the newest verified snapshot even when every bucket would prune it', () => {
    // The 4 newest pre-updates are unverified; the 4th is the newest verified snapshot.
    const snapshots = [
      snapshot('pre-update-old', 'pre-update', '2026-09-01T00:00:00.000Z', { verified: true }),
      snapshot('pre-update-a', 'pre-update', '2026-09-02T00:00:00.000Z', { verified: false }),
      snapshot('pre-update-b', 'pre-update', '2026-09-03T00:00:00.000Z', { verified: false }),
      snapshot('pre-update-c', 'pre-update', '2026-09-04T00:00:00.000Z', { verified: false }),
    ];
    const result = plan(snapshots);
    expect([...result.keep].sort()).toEqual([
      'pre-update-a',
      'pre-update-b',
      'pre-update-c',
      'pre-update-old',
    ]);
    expect(result.prune).toEqual([]);
  });

  it('keeps every protected id, and ignores a protected id that is not a snapshot', () => {
    const result = plan(series('pre-update', 5), {
      protectedIds: ['pre-update-1', 'no-such-snapshot'],
    });
    expect(result.keep).toContain('pre-update-1');
    expect(result.keep).not.toContain('no-such-snapshot');
    expect(prunedIds(result)).toEqual(['pre-update-2']);
  });

  it('partitions the input: every snapshot is either kept or pruned, exactly once', () => {
    const snapshots = [
      ...series('pre-update', 6),
      ...series('daily', 9),
      ...series('pre-repair', 5),
      ...series('manual', 2),
    ];
    const result = plan(snapshots);
    const all = [...result.keep, ...result.prune.map((entry) => entry.id)].sort();
    expect(all).toEqual(snapshots.map((entry) => entry.id).sort());
  });

  it('plans nothing for no snapshots', () => {
    expect(plan([])).toEqual({ keep: [], overCap: false, overCapBytes: 0, prune: [] });
  });

  it('rejects a snapshot whose createdAt is not a date, instead of guessing its age', () => {
    expect(() => plan([snapshot('bad', 'daily', 'yesterday')])).toThrow(/bad.*createdAt/u);
  });
});

describe('planSnapshotRetention size cap', () => {
  const cap = (capBytes: number): SnapshotRetentionPolicy => ({
    ...DEFAULT_SNAPSHOT_RETENTION_POLICY,
    capBytes,
  });

  it('prunes nothing when the kept snapshots fit', () => {
    const result = plan(dailiesOn(daysBetween('2026-09-27', '2026-09-29')), {
      policy: cap(3 * MIB),
    });
    expect(result.prune).toEqual([]);
    expect(result.overCap).toBe(false);
    expect(result.overCapBytes).toBe(0);
  });

  it('prunes the oldest automatic snapshots first, stops as soon as the total fits, and names the rule it overrode', () => {
    // Four dailies on four days plus two pre-updates, all kept by their rules (6 MiB); a 4 MiB cap.
    const snapshots = [
      ...dailiesOn(daysBetween('2026-09-26', '2026-09-29')),
      ...series('pre-update', 2, { startHour: 10 }),
    ];
    const result = plan(snapshots, { policy: cap(4 * MIB) });
    expect(result.prune).toEqual([
      { id: 'd-2026-09-26', overrides: ['daily'], why: 'size-cap' },
      { id: 'd-2026-09-27', overrides: ['daily', 'weekly'], why: 'size-cap' },
    ]);
    expect(result.overCap).toBe(false);
    expect(result.overCapBytes).toBe(0);
    expect(result.keep).toHaveLength(4);
  });

  it('never prunes manual or imported snapshots, and reports how far over the cap that leaves it', () => {
    const result = plan(series('manual', 3), { policy: cap(MIB) });
    expect(result.prune).toEqual([]);
    expect(result.overCap).toBe(true);
    expect(result.overCapBytes).toBe(2 * MIB);
  });

  it('never prunes a protected id or the newest verified snapshot to meet the cap', () => {
    const snapshots = [
      ...dailiesOn(daysBetween('2026-09-27', '2026-09-29'), { verified: false }),
      snapshot('newest-verified', 'pre-update', '2026-09-10T00:00:00.000Z', { verified: true }),
      snapshot('just-published', 'pre-update', '2026-09-11T00:00:00.000Z', { verified: false }),
    ];
    const result = plan(snapshots, { policy: cap(MIB), protectedIds: ['just-published'] });
    expect(result.keep).toEqual(expect.arrayContaining(['newest-verified', 'just-published']));
    expect(result.prune.every((entry) => entry.why === 'size-cap')).toBe(true);
    expect(prunedIds(result)).toEqual(['d-2026-09-27', 'd-2026-09-28', 'd-2026-09-29']);
    expect(result.overCap).toBe(true);
    expect(result.overCapBytes).toBe(MIB);
  });

  it('counts only kept snapshots toward the cap, so a bucket prune can satisfy it', () => {
    // 5 pre-updates keep 3 in the bucket; the 3 kept are 3 MiB, under a 3 MiB cap.
    const result = plan(series('pre-update', 5), { policy: cap(3 * MIB) });
    expect(result.prune.every((entry) => entry.why === 'bucket')).toBe(true);
    expect(result.overCap).toBe(false);
  });
});

describe('DEFAULT_SNAPSHOT_RETENTION_POLICY', () => {
  it('is 3 pre-update, 3 repair, 7 daily, 4 weekly and a 20 GiB logical cap', () => {
    expect(DEFAULT_SNAPSHOT_RETENTION_POLICY).toEqual({
      capBytes: 20 * 1024 ** 3,
      daily: 7,
      preUpdate: 3,
      repair: 3,
      weekly: 4,
    });
  });
});
