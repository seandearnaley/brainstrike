import type { attachAgentHost, HostLogRow, HostRunTelemetry } from '@brainstrike/agent-host';
import { z } from 'zod';

type HostClient = Awaited<ReturnType<typeof attachAgentHost>>;

const SHELL_OUTPUT_CHUNK = 'brainstrike.shell-output.chunk';

/**
 * A running command's output is uncommitted run telemetry (ADR-0011
 * amendment). Collect a thread's telemetry on this client's own subscription.
 */
export async function watchThreadTelemetry(
  client: HostClient,
  threadId: string
): Promise<{ readonly received: readonly HostRunTelemetry[]; readonly release: () => void }> {
  const received: HostRunTelemetry[] = [];
  const release = client.onTelemetry((telemetry) => {
    if (telemetry.threadId === threadId) {
      received.push(telemetry);
    }
  });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  return { received, release };
}

/** How many live slices are exactly this stdout chunk of this committed effect. */
export function liveStdoutSlices(
  received: readonly HostRunTelemetry[],
  effect: { readonly runId: string; readonly toolCallId: string },
  chunk: string
): number {
  const slice = z.strictObject({
    chunk: z.literal(chunk),
    stream: z.literal('stdout'),
    toolCallId: z.literal(effect.toolCallId),
    type: z.literal(SHELL_OUTPUT_CHUNK),
  });
  return received.filter(
    (telemetry) =>
      telemetry.runId === effect.runId &&
      telemetry.toolCallId === effect.toolCallId &&
      slice.safeParse(telemetry.chunk).success
  ).length;
}

/** Committed rows that carry a shell-output slice; telemetry never commits one. */
export function committedShellSlices(rows: readonly HostLogRow[]): readonly HostLogRow[] {
  return rows.filter(
    ({ event }) =>
      event.type === 'stream.chunk' &&
      typeof event.chunk === 'object' &&
      event.chunk !== null &&
      !Array.isArray(event.chunk) &&
      event.chunk['type'] === SHELL_OUTPUT_CHUNK
  );
}
