import { useMemo, useState } from 'react';
import { createShellOutputAccumulator, type ShellOutputAccumulation } from './shell-output-parts';

/**
 * A message's accumulated shell output, keeping the record's identity until a
 * new slice arrives. The accumulator resets itself when the message id changes.
 */
export function useShellOutputs(
  messageId: string,
  messageParts: readonly unknown[]
): Record<string, ShellOutputAccumulation> {
  const [accumulate] = useState(() => createShellOutputAccumulator());
  return useMemo(() => accumulate(messageId, messageParts), [accumulate, messageId, messageParts]);
}
