import { use, useMemo, useState, useSyncExternalStore } from 'react';
import { LiveShellOutputContext } from './live-shell-outputs';
import { createShellOutputAccumulator, type ShellOutputAccumulation } from './shell-output-parts';

const NO_LIVE_OUTPUT: Readonly<Record<string, ShellOutputAccumulation>> = {};
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;
const readNoLiveOutput = (): Readonly<Record<string, ShellOutputAccumulation>> => NO_LIVE_OUTPUT;

/**
 * A message's accumulated shell output, keeping the record's identity until a
 * new slice arrives. The accumulator resets itself when the message id changes.
 * A host thread's live slices arrive as telemetry, not message parts, and join
 * here by tool call until the tool's result commits.
 */
export function useShellOutputs(
  messageId: string,
  messageParts: readonly unknown[]
): Record<string, ShellOutputAccumulation> {
  const [accumulate] = useState(() => createShellOutputAccumulator());
  const fromParts = useMemo(
    () => accumulate(messageId, messageParts),
    [accumulate, messageId, messageParts]
  );
  const live = use(LiveShellOutputContext);
  const liveOutputs = useSyncExternalStore(
    live?.subscribe ?? NO_SUBSCRIPTION,
    live?.getSnapshot ?? readNoLiveOutput,
    live?.getSnapshot ?? readNoLiveOutput
  );
  return useMemo(() => {
    if (liveOutputs === NO_LIVE_OUTPUT || Object.keys(liveOutputs).length === 0) {
      return fromParts;
    }
    return Object.keys(fromParts).length === 0 ? liveOutputs : { ...fromParts, ...liveOutputs };
  }, [fromParts, liveOutputs]);
}
