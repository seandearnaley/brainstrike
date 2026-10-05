export interface WalCutRange {
  readonly first: number;
  readonly last: number;
}

function assertBounds(first: number, last: number): void {
  if (!(Number.isSafeInteger(first) && Number.isSafeInteger(last)) || first < 0 || last < first) {
    throw new Error(`invalid WAL cut bounds ${first}..${last}`);
  }
}

export function partitionWalCuts(first: number, last: number, count: number): WalCutRange[] {
  assertBounds(first, last);
  const total = last - first + 1;
  if (!(Number.isSafeInteger(total) && Number.isSafeInteger(count)) || count < 1 || count > total) {
    throw new Error(`invalid WAL partition count ${count} for ${total} cuts`);
  }
  return Array.from({ length: count }, (_, index) => ({
    first: first + Math.floor((total * index) / count),
    last: first + Math.floor((total * (index + 1)) / count) - 1,
  }));
}

export function assertWalCutCoverage(
  ranges: readonly WalCutRange[],
  first: number,
  last: number
): void {
  assertBounds(first, last);
  if (ranges.length === 0) {
    throw new Error('WAL cut coverage is empty');
  }
  let next = first;
  for (const range of ranges) {
    assertBounds(range.first, range.last);
    if (range.first !== next || range.last > last) {
      throw new Error(
        `WAL cut coverage gap or duplicate at ${next}: ${range.first}..${range.last}`
      );
    }
    next = range.last + 1;
  }
  if (next !== last + 1) {
    throw new Error(`WAL cut coverage omits endpoint ${last}`);
  }
}

export function matchesRecoveredWalCommit(
  cut: number,
  last: number,
  rows: number,
  quickCheck: unknown
): boolean {
  return rows === (cut === last ? 50 : 49) && quickCheck === 'ok';
}

export function assertWalCutOffsets(cuts: readonly number[], first: number, last: number): void {
  assertBounds(first, last);
  if (cuts.length !== last - first + 1) {
    throw new Error(`WAL completed ${cuts.length} cuts; expected ${last - first + 1}`);
  }
  for (const [index, cut] of cuts.entries()) {
    if (cut !== first + index) {
      throw new Error(`WAL completed-cut gap or duplicate: expected ${first + index}, got ${cut}`);
    }
  }
}
