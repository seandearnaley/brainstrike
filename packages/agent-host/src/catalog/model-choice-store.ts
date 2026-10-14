import type { ModelChoicePort, ModelChoiceResult } from '@brainstrike/state-store';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';

const Id = z.string().min(1);
const ModelChoice = z.strictObject({ enabled: z.boolean(), modelId: Id, providerId: Id });
const ProviderChoice = z.strictObject({ enabled: z.boolean(), providerId: Id });
const Request = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('snapshot') }),
  z.strictObject({ operation: z.literal('provider'), ...ProviderChoice.shape }),
  z.strictObject({ models: z.array(ModelChoice).min(1), operation: z.literal('models') }),
  z.strictObject({
    modelIds: z.array(Id),
    operation: z.literal('initialize'),
    policy: z.enum(['all', 'seed']),
    providerId: Id,
  }),
]);
const Snapshot = z.strictObject({
  models: z.array(ModelChoice),
  providers: z.array(ProviderChoice),
});
const Result = Snapshot.extend({
  outcome: z.enum(['initialized', 'preserved']).optional(),
  previous: Snapshot.optional(),
});
const METHOD = 'host/model-choices';

/** Catalog identities are validated before reaching the one acquired host writer. */
export function serveModelChoiceStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: ModelChoicePort
): { close(): Promise<void> } {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<ModelChoiceResult>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
      throw new Error('Model choice endpoint is closing');
    }
    const request = Request.parse(input);
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
      const result = Result.parse(
        await sendCatalogRequest(connection, METHOD, Request.parse(request))
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
