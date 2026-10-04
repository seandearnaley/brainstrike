function validate(samples, percent) {
  if (samples.length === 0) {
    throw new Error('Missing measurement samples');
  }
  if (samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Measurements must be finite and nonnegative');
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error('Percentile must be between zero and 100');
  }
}

export function displayPercentile(samples, percent) {
  validate(samples, percent);
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)];
}

export function contentionPercentile(samples, percent) {
  validate(samples, percent);
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((percent / 100) * sorted.length))];
}

export const rounded = (number) => Number(number.toFixed(3));

export function summary(samples, percentile) {
  return /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
    n: samples.length,
    p50: rounded(percentile(samples, 50)),
    p95: rounded(percentile(samples, 95)),
    max: rounded(Math.max(...samples)),
  };
}

export function evaluate(display, ratios) {
  const sqlite = rounded(displayPercentile(display.S, 95));
  const pglite = rounded(displayPercentile(display.P, 95));
  if (ratios.length !== 3) {
    throw new Error('S contention requires exactly three fresh processes');
  }
  validate(ratios, 50);
  const median = [...ratios].sort((a, b) => a - b)[1];
  return /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
    display:
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        sqliteP95: sqlite,
        pgliteP95: pglite,
        limit: pglite + 5,
        pass: sqlite <= pglite + 5,
      },
    contention:
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        ratios,
        median,
        limit: 2,
        pass: median <= 2,
        method: 'Three-run S median: explicitly approved port of J-worker test aggregation',
      },
  };
}
