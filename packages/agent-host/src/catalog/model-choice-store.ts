import type { ModelChoicePort, ModelChoiceResult } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { sendCatalogRequest } from './request.js';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const ModelChoice = Schema.Struct({ enabled: Schema.Boolean, modelId: Id, providerId: Id });
const ProviderChoice = Schema.Struct({ enabled: Schema.Boolean, providerId: Id });
const Request = Schema.Union(
  [
    Schema.Struct({ operation: Schema.Literal('snapshot') }),
    Schema.Struct({ operation: Schema.Literal('provider'), ...ProviderChoice.fields }),
    Schema.Struct({
      models: Schema.mutable(Schema.Array(ModelChoice)).check(Schema.isMinLength(1)),
      operation: Schema.Literal('models'),
    }),
    Schema.Struct({
      modelIds: Schema.mutable(Schema.Array(Id)),
      operation: Schema.Literal('initialize'),
      policy: Schema.Literals(['all', 'seed']),
      providerId: Id,
    }),
  ],
  { mode: 'oneOf' }
);
const Snapshot = Schema.Struct({
  models: Schema.mutable(Schema.Array(ModelChoice)),
  providers: Schema.mutable(Schema.Array(ProviderChoice)),
});
const Result = Schema.Struct({
  ...Snapshot.fields,
  ...{
    outcome: Schema.optional(Schema.Literals(['initialized', 'preserved'])),
    previous: Schema.optional(Snapshot),
  },
});
const METHOD = 'host/model-choices';
/** Catalog identities are validated before reaching the one acquired host writer. */
export function serveModelChoiceStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: ModelChoicePort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<ModelChoiceResult>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing !== undefined) {
      throw new Error('Model choice endpoint is closing');
    }
    const request = Schema.decodeUnknownSync(Request, { errors: 'all', onExcessProperty: 'error' })(
      input
    );
    const work = store.modelChoices(request);
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  });
  return {
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        while (pending.size > 0) {
          await Promise.allSettled([...pending]);
        }
        subscription.dispose();
      });
      return closing;
    },
  };
}
export function createModelChoiceClient(connection: MessageConnection): ModelChoicePort {
  return {
    modelChoices: async (request) => {
      const result = Schema.decodeUnknownSync(Result, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(
          connection,
          METHOD,
          Schema.decodeUnknownSync(Request, { errors: 'all', onExcessProperty: 'error' })(request)
        )
      );
      return {
        models: result.models,
        providers: result.providers,
        ...(result.previous === undefined ? {} : { previous: result.previous }),
        ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
      };
    },
  };
}
