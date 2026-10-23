import {
  decodeIndexConfig,
  type IndexConfig,
  IndexConfigSchema,
} from '@brainstrike/assistant-contract/index-config';
import type { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { sendCatalogRequest } from './request.js';

/** The StateStore setting holding the profile's one search index config. */
export const INDEX_CONFIG_SETTING = 'index/config';
const PARSE = { errors: 'all', onExcessProperty: 'error' } as const;
const Request = Schema.Union(
  [
    Schema.Struct({ operation: Schema.Literal('read') }),
    Schema.Struct({ config: IndexConfigSchema, operation: Schema.Literal('write') }),
  ],
  { mode: 'oneOf' }
);
const Reply = Schema.Struct({ config: Schema.NullOr(IndexConfigSchema) });
const METHOD = 'host/index-config';

export type IndexConfigRequest = typeof Request.Type;
export interface IndexConfigPort {
  /** Null until Main first saves one; Main supplies the fresh-profile default. */
  indexConfig(request: IndexConfigRequest): Promise<{ readonly config: IndexConfig | null }>;
}
export type IndexConfigSettings = Pick<StateStore, 'getSetting' | 'setSetting'>;

async function execute(
  store: IndexConfigSettings,
  request: IndexConfigRequest
): Promise<{ readonly config: IndexConfig | null }> {
  if (request.operation === 'write') {
    await store.setSetting(INDEX_CONFIG_SETTING, JSON.stringify(request.config));
    return { config: request.config };
  }
  const saved = await store.getSetting(INDEX_CONFIG_SETTING);
  return { config: saved === undefined ? null : decodeIndexConfig(JSON.parse(saved)) };
}

/** Decoded on arrival and served by the one acquired writer, never a second store. */
export function serveIndexConfigStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: IndexConfigSettings
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing !== undefined) {
      throw new Error('Index config endpoint is closing');
    }
    const work = execute(store, Schema.decodeUnknownSync(Request, PARSE)(input));
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

export function createIndexConfigClient(connection: MessageConnection): IndexConfigPort {
  return {
    indexConfig: async (request) =>
      Schema.decodeUnknownSync(
        Reply,
        PARSE
      )(await sendCatalogRequest(connection, METHOD, Schema.decodeSync(Request, PARSE)(request))),
  };
}
