import type { EvalMode } from './results.ts';

/** The provider a live eval may run: the owner's benchmark key is Anthropic's. */
const LIVE_EVAL_MODEL = /^anthropic::\S+$/u;

/** Live mode makes paid calls: it needs `--live`, `BRAINSTRIKE_EVALS_LIVE=1`, and never CI. */
export function assertLiveAllowed(
  live: boolean,
  env: Readonly<Record<string, string | undefined>>
): void {
  if (env['CI']) {
    throw new Error('Live mode makes paid provider calls and never runs in CI');
  }
  if (!(live && env['BRAINSTRIKE_EVALS_LIVE'] === '1')) {
    throw new Error(
      'Live mode makes paid provider calls: pass --live with BRAINSTRIKE_EVALS_LIVE=1'
    );
  }
}

/**
 * `--max-spend-usd`: a live run's hard cap in US dollars, which it must name.
 * Scripted and replay runs make no paid call, so they refuse one rather than
 * ignore it.
 */
export function evalSpendCap(mode: EvalMode, value: string | undefined): number | undefined {
  if (mode !== 'live') {
    if (value !== undefined) {
      throw new Error(`--max-spend-usd caps a live run; a ${mode} run makes no paid call`);
    }
    return;
  }
  if (value === undefined) {
    throw new Error(
      'Live mode makes paid provider calls: pass --max-spend-usd <dollars> to cap them'
    );
  }
  const capUsd = value.trim() === '' ? Number.NaN : Number(value);
  if (!(Number.isFinite(capUsd) && capUsd > 0)) {
    throw new Error(`--max-spend-usd must be a positive number of US dollars, not ${value}`);
  }
  return capUsd;
}

/**
 * The model a run names: a live run's `--model`, else the task's own, and
 * Anthropic's only. Scripted and replay runs take no `--model`: a script plays
 * as its own model and a cassette replays the model it recorded.
 */
export function evalRunModel(
  mode: EvalMode,
  flag: string | undefined,
  taskModel: string
): string | undefined {
  if (mode !== 'live') {
    if (flag !== undefined) {
      throw new Error(
        `--model names a live run’s model; a ${mode} run ${mode === 'scripted' ? 'plays its script as its own model' : 'replays the model its cassette recorded'}`
      );
    }
    return;
  }
  const model = flag ?? taskModel;
  if (!LIVE_EVAL_MODEL.test(model)) {
    throw new Error(
      `A live eval runs Anthropic models only (--model anthropic::<model>), not ${model}`
    );
  }
  return model;
}
