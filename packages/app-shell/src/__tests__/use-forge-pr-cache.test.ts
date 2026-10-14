import { forgePrCacheKey } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { projectForgePrRows } from '../hooks/use-forge-pr-cache';

function passingRow(): Record<string, unknown> {
  return {
    branch: 'main',
    checksRollup: 'passing',
    isDraft: false,
    number: 2574,
    repoCommonDir: '/repos/widgets/.git',
    state: 'open',
    url: 'https://github.test/acme/widgets/pull/2574',
  };
}

describe('projectForgePrRows', () => {
  it('keys a normal entry by repository and branch and derives its checks rollup', () => {
    const projected = projectForgePrRows([
      {
        ...passingRow(),
        checksRollup: 'failing',
      },
    ]);

    expect(projected.error).toBeNull();
    expect(projected.byRepoBranch.get(forgePrCacheKey('/repos/widgets/.git', 'main'))).toEqual({
      branch: 'main',
      checksRollup: 'failing',
      isDraft: false,
      number: 2574,
      repoCommonDir: '/repos/widgets/.git',
      state: 'open',
      url: 'https://github.test/acme/widgets/pull/2574',
    });
  });

  it("accepts the writer's normalized pending rollup", () => {
    const projected = projectForgePrRows([
      {
        ...passingRow(),
        checksRollup: 'pending',
      },
    ]);

    expect(projected.error).toBeNull();
    expect(
      projected.byRepoBranch.get(forgePrCacheKey('/repos/widgets/.git', 'main'))?.checksRollup
    ).toBe('pending');
  });

  it('fails the whole projection when one PR row is malformed', () => {
    const projected = projectForgePrRows([passingRow(), { ...passingRow(), number: 'nope' }]);

    expect(projected.error).toBeInstanceOf(Error);
    expect(projected.byRepoBranch.size).toBe(0);
  });

  it('fails the projection on a non-integer number rather than coercing it', () => {
    const projected = projectForgePrRows([{ ...passingRow(), number: 2574.5 }]);

    expect(projected.error).toBeInstanceOf(Error);
    expect(projected.byRepoBranch.size).toBe(0);
  });

  it('fails when cached checks use an unreadable raw provider shape', () => {
    const projected = projectForgePrRows([{ ...passingRow(), checksRollup: 'COMPLETED' }]);

    expect(projected.error).toBeInstanceOf(Error);
    expect(projected.byRepoBranch.size).toBe(0);
  });

  it('skips a durable none observation without discarding valid entries', () => {
    const projected = projectForgePrRows([
      passingRow(),
      {
        branch: 'release',
        checksRollup: null,
        isDraft: null,
        number: null,
        repoCommonDir: '/repos/widgets/.git',
        state: null,
        url: null,
      },
    ]);

    expect(projected.error).toBeNull();
    expect(projected.byRepoBranch.size).toBe(1);
    expect(projected.byRepoBranch.has(forgePrCacheKey('/repos/widgets/.git', 'release'))).toBe(
      false
    );
  });
});

it('rejects SQLite integers at the renderer boundary instead of coercing draft state', () => {
  const projected = projectForgePrRows([{ ...passingRow(), isDraft: 1 }]);
  expect(projected.error).toBeInstanceOf(Error);
  expect(projected.byRepoBranch.size).toBe(0);
});
