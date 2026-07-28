interface CooperativeYieldOptions {
  readonly checkEvery: number;
  readonly now?: () => number;
  readonly yieldAfterMs: number;
  readonly yieldControl?: () => Promise<void>;
}

const yieldToMacrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export function createCooperativeYieldController({
  checkEvery,
  now = performance.now.bind(performance),
  yieldAfterMs,
  yieldControl = yieldToMacrotask,
}: CooperativeYieldOptions): () => Promise<void> {
  if (!Number.isInteger(checkEvery) || checkEvery <= 0) {
    throw new RangeError('Yield check cadence must be a positive integer');
  }
  if (!(Number.isFinite(yieldAfterMs) && yieldAfterMs >= 0)) {
    throw new RangeError('Yield time budget must be a finite non-negative number');
  }

  let processedItems = 0;
  let lastYieldAt = now();

  return async (): Promise<void> => {
    processedItems += 1;
    if (processedItems % checkEvery !== 0) {
      return;
    }

    const currentTime = now();
    if (currentTime - lastYieldAt < yieldAfterMs) {
      return;
    }

    await yieldControl();
    lastYieldAt = currentTime;
  };
}
