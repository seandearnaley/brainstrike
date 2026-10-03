import { type IndexerProcessEndpoint, runIndexerProcess } from '@brainstrike/indexer/host';
import { Schema } from 'effect';
import { CanonicalUtilityChild } from './canonical-utility-child';
import { assertCanonicalMessageBound, isCanonicalFrame } from './canonical-utility-protocol';

/** One actual engine process, with the desktop runtime attached to its same message stream. */
export function runCanonicalIndexerProcess(
  input: unknown,
  endpoint: Omit<IndexerProcessEndpoint, 'onDisconnect'>
): Promise<void> {
  const canonical = new CanonicalUtilityChild((value) => {
    assertCanonicalMessageBound(value);
    endpoint.send(value);
  });
  return runIndexerProcess(input, {
    finish: () => endpoint.finish(),
    onMessage: (listener) =>
      endpoint.onMessage((message) => {
        if (isCanonicalFrame(message)) {
          canonical.receive(message);
          return;
        }
        const closing = Schema.is(Schema.Struct({ id: Schema.Int, op: Schema.Literal('close') }));
        if (!closing(message)) {
          listener(message);
          return;
        }
        const request = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Int }))(message);
        void canonical.close().then(
          () => listener(message),
          (error: unknown) =>
            endpoint.send({
              error: {
                code: 'canonical-close-failed',
                message: error instanceof Error ? error.message : String(error),
              },
              id: request.id,
              kind: 'response',
              ok: false,
            })
        );
      }),
    send: (value) => endpoint.send(value),
  });
}
