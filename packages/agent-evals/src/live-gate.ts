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
