type Settlement = 'begin' | 'end' | 'failure';
export type DocumentCloseProofPhase =
  | `${
      | 'renderer-prepare'
      | 'renderer-producers'
      | 'renderer-persistence'
      | 'host-connection-close'
      | 'preload-prepare'
      | 'reset'
      | 'reset-transition'
      | 'reset-stop-sources'
      | 'reset-lease'
      | 'reset-clear'
      | 'reset-release'
      | 'reset-resume'
      | 'reset-dialog'}-${Settlement}`
  | 'preload-ack-success-dispatch'
  | 'preload-ack-failure-dispatch';

/** PROOF ONLY: the existing bounded metadata line format; no payloads or errors. */
export function createDocumentCloseProof(
  enabled: boolean,
  realm: 'main' | 'preload' | 'renderer'
): (phase: DocumentCloseProofPhase) => void {
  let sequence = 0;
  return (phase) => {
    if (!enabled || sequence >= 513) {
      return;
    }
    sequence += 1;
    // biome-ignore lint/suspicious/noConsole: pure proof sink must remain sandbox-preload safe.
    console.warn(
      `[document-close-proof] ${JSON.stringify({
        at: Date.now(),
        monotonicMs: performance.now(),
        phase: sequence === 513 ? 'truncated' : phase,
        realm,
        sequence,
        timeOrigin: performance.timeOrigin,
      })}`
    );
  };
}
