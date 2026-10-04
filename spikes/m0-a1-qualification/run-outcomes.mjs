function requireCompleted(result, label) {
  if (result?.status !== 'completed' || result.error !== undefined) {
    throw new Error(
      `Unsuccessful terminal result: ${label}, status=${result?.status}, error=${result?.error}`
    );
  }
}

/** Inspect public settled results after the measured window and before accepting a record. */
export async function validateRunOutcomes(host, childLabels, rootResult) {
  requireCompleted(rootResult, 'root');
  const labels = ['root', ...childLabels, 'root-wake'];
  const outcomes = [];
  for (const label of labels) {
    const run = host.runByLabel(label);
    if (!run) {
      throw new Error(`Missing expected run: ${label}`);
    }
    const result = await host.result(run.runId);
    if (!result) {
      throw new Error(`Missing terminal result: ${label}`);
    }
    requireCompleted(result, label);
    if (label === 'root' && rootResult?.runId !== run.runId) {
      throw new Error('Root completion does not match the expected root run');
    }
    outcomes.push(
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        label,
        runId: result.runId,
        threadId: result.threadId,
        status: result.status,
      }
    );
  }
  return outcomes;
}
