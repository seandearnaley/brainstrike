import type { MessageConnection, StreamMessageReader } from 'vscode-jsonrpc/node';

/** Input is physically closed; join admitted decoding and dispatch before disposal. */
export async function closeReceivedConnection(
  reader: Pick<StreamMessageReader, 'drain'> | undefined,
  connection: Pick<MessageConnection, 'drain' | 'dispose'> | undefined,
  receivedFailures: ReadonlySet<unknown> = new Set()
): Promise<void> {
  const failures = new Set(receivedFailures);
  for (const operation of [
    () => reader?.drain(),
    () => connection?.drain(),
    () => connection?.dispose(),
  ]) {
    try {
      await operation();
    } catch (cause) {
      failures.add(cause);
    }
  }
  // Decoding can publish its error while the first stage settles.
  for (const cause of receivedFailures) {
    failures.add(cause);
  }
  if (failures.size === 1) {
    throw failures.values().next().value;
  }
  if (failures.size > 1) {
    throw new AggregateError([...failures], 'Host client receive and disposal failed');
  }
}
