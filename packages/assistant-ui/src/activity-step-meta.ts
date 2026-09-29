import type { ActivityStep } from './activity-trace-model';

export interface ActivityStepMeta {
  /** `toolCallId` of the LAST tool step in part order whose state is `running`; null when none. */
  readonly lastRunningId: string | null;
}

/**
 * The one presentation fact a card cannot derive from its own props: whether
 * it is the group's last running step — the only row that shimmers (spec
 * §4.3 L1). Pure; the group computes it once per snapshot and hands it down
 * through `ActivityStepMetaProvider`. Reasoning steps are excluded: a
 * streaming reasoning part is always last (a tool-call part closes it) and
 * its row keeps its own indicator.
 */
export function deriveStepMeta(steps: readonly ActivityStep[]): ActivityStepMeta {
  const last = steps.findLast((step) => step.kind === 'tool' && step.state === 'running');
  return { lastRunningId: last?.id ?? null };
}
