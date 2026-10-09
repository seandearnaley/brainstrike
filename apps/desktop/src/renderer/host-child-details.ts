import { tokensOf } from '@brainstrike/agent-host/ledger-projection';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { HostChildToolbarDetails } from '@brainstrike/app-shell';
import { readChildExecutionConfiguration } from '@brainstrike/assistant-contract';
import { z } from 'zod';

/** The desktop's committed run configuration names the model settings the run was admitted with. */
const CommittedIntentSchema = z.object({ intent: z.unknown() });
const CommittedModelConfigurationSchema = z.object({
  modelConfiguration: z.object({
    model: z.string(),
    modelSettings: z.unknown().optional(),
    provider: z.string(),
    providerOptions: z.unknown().optional(),
  }),
});

/** A run's admitted model settings: read, unreadable, or never recorded (a non-desktop client). */
function admittedExecution(
  configuration: unknown,
  planMode: boolean
): Pick<HostChildToolbarDetails, 'execution' | 'executionUnreadable'> {
  const committed = CommittedIntentSchema.safeParse(configuration);
  if (!committed.success) {
    return {};
  }
  const parsed = CommittedModelConfigurationSchema.safeParse(committed.data.intent);
  if (!parsed.success) {
    return { executionUnreadable: true };
  }
  const { model, modelSettings, provider, providerOptions } = parsed.data.modelConfiguration;
  try {
    return {
      execution: readChildExecutionConfiguration({
        model,
        ...(modelSettings === undefined ? {} : { modelSettings }),
        planMode,
        provider,
        ...(providerOptions === undefined ? {} : { providerOptions }),
      }),
    };
  } catch {
    // The toolbar states the settings are unavailable; it never shows a guess.
    return { executionUnreadable: true };
  }
}

/**
 * BST-1932 (F15): a host child's toolbar facts, folded incrementally from its
 * own committed log: the persona profile its origin recorded, its latest
 * run's admitted model, mode, step budget and tools, the steps that run has
 * taken, and the tokens all its runs have used. Nothing is read from current
 * settings. The value keeps its identity until one of those facts changes.
 */
export class HostChildDetailsFold {
  private cursor = 0;
  private origin: Extract<HostLogRow['event'], { type: 'thread.started' }> | undefined;
  private latest: Extract<HostLogRow['event'], { type: 'run.started' }> | undefined;
  private steps = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private value: HostChildToolbarDetails | undefined;

  /** Fold the rows past the last call; `rows` is the same log, grown. */
  apply(rows: readonly HostLogRow[]): HostChildToolbarDetails | undefined {
    if (rows.length < this.cursor) {
      throw new Error('A child log never shrinks');
    }
    let changed = false;
    for (const { event } of rows.slice(this.cursor)) {
      if (event.type === 'thread.started' && 'origin' in event) {
        this.origin = event;
        changed = true;
      } else if (event.type === 'run.started') {
        this.latest = event;
        this.steps = 0;
        changed = true;
      } else if (event.type === 'model.step') {
        const tokens = tokensOf(event.usage);
        this.inputTokens += tokens.inputTokens;
        this.outputTokens += tokens.outputTokens;
        this.steps += event.runId === this.latest?.runId ? 1 : 0;
        changed = true;
      }
    }
    this.cursor = rows.length;
    if (changed) {
      this.value = this.details();
    }
    return this.value;
  }

  private details(): HostChildToolbarDetails | undefined {
    const { latest, origin } = this;
    if (!(origin && 'origin' in origin && latest)) {
      return;
    }
    const planMode = latest.planMode === true;
    const snapshot = latest.snapshot;
    return {
      depth: origin.origin.depth,
      ...admittedExecution(snapshot?.configuration, planMode),
      ...(snapshot
        ? { maxSteps: snapshot.maxSteps, tools: Object.keys(snapshot.toolIdentities) }
        : {}),
      modelId: latest.modelId,
      planMode,
      ...(origin.origin.profile ? { profile: origin.origin.profile } : {}),
      steps: this.steps,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
    };
  }
}

/** One child log's toolbar facts, folded from its first row. */
export function foldHostChildDetails(
  rows: readonly HostLogRow[]
): HostChildToolbarDetails | undefined {
  return new HostChildDetailsFold().apply(rows);
}
