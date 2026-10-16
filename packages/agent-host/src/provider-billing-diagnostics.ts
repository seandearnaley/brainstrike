import { readOpenRouterBilledCost } from '@brainstrike/agent/provider-runtime';
import { createLogger } from '@brainstrike/logging';
import { finishHostRun, type HostRunOwnerLifetime } from './core-run-lifecycle.js';
import type { HostRunState } from './core-state.js';
import type { HostEvent, HostLogRow } from './protocol.js';

const logger = createLogger('AgentHost');

/** Derive turn completeness from the original committed SDK step metadata. */
function reportHostProviderBilling(rows: readonly HostLogRow[], runId: string): void {
  const readings = rows.flatMap(({ event }) => {
    if (event.type !== 'stream.chunk' || event.runId !== runId) {
      return [];
    }
    const chunk = event.chunk;
    if (
      chunk === null ||
      typeof chunk !== 'object' ||
      Array.isArray(chunk) ||
      chunk['type'] !== 'finish-step'
    ) {
      return [];
    }
    return [readOpenRouterBilledCost({ providerMetadata: chunk['providerMetadata'] })];
  });
  if (readings.length === 0) {
    return;
  }
  const malformed = readings.find((reading) => reading.kind === 'malformed');
  if (malformed?.kind === 'malformed') {
    logger.error('Provider reported a malformed billed cost; recording the turn cost as unknown', {
      code: 'provider_billed_cost_malformed',
      reason: malformed.reason,
    });
  }
  if (readings.every((reading) => reading.kind === 'reported')) {
    return;
  }
  const reported = readings.flatMap((reading) =>
    reading.kind === 'reported' ? [reading.usd] : []
  );
  logger.warn(
    reported.length > 0
      ? 'Provider reported a cost for only some steps; recording the turn cost as unknown'
      : 'Provider reported no billed cost; recording the turn cost as unknown',
    {
      code: 'provider_billed_cost_unreported',
      ...(reported.length > 0
        ? { discardedPartialCostUsd: reported.reduce((total, cost) => total + cost, 0) }
        : {}),
      sawStepBilledCost: reported.length > 0,
      sawStepWithoutBilledCost: true,
      stepCount: readings.length,
    }
  );
}

/** The existing completion owner fences diagnostic publication across repeats. */
export function finishHostRunWithProviderBilling(
  run: HostRunState,
  outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
  detail: string | undefined,
  closing: () => boolean,
  owner: HostRunOwnerLifetime,
  readHistory: () => Promise<readonly HostLogRow[]>,
  publish: (
    event: Extract<HostEvent, { type: 'run.finished' }>,
    commit: () => void
  ) => Promise<unknown>
): Promise<void> {
  return finishHostRun(run, outcome, detail, closing, owner, async (event, commit) => {
    const provider =
      run.admission?.configuration.provider ?? run.snapshot?.configuration['provider'];
    const history =
      event.outcome === 'completed' && provider === 'openrouter' ? await readHistory() : undefined;
    return publish(event, () => {
      commit();
      if (history) {
        reportHostProviderBilling(history, run.id);
      }
    });
  });
}
