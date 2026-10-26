// @vitest-environment node
import { PassThrough } from 'node:stream';
import {
  DEFAULT_INDEX_CONFIG,
  INDEX_CONFIG_RESET_REMEDY,
  INDEX_CONFIG_UNREADABLE,
} from '@brainstrike/assistant-contract/index-config';
import { expect, test } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { toBoundaryResponseError } from '../src/boundary-wire.ts';
import {
  createIndexConfigClient,
  INDEX_CONFIG_SETTING,
  type IndexConfigSettings,
  serveIndexConfigStore,
} from '../src/catalog/index-config-store.ts';

function settings(): IndexConfigSettings & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    getSetting: async (key) => values.get(key),
    setSetting: async (key, value) => {
      values.set(key, value);
    },
    values,
  };
}

function transport(store: IndexConfigSettings) {
  const requests = new PassThrough();
  const responses = new PassThrough();
  const main = createMessageConnection(
    new StreamMessageReader(responses),
    new StreamMessageWriter(requests)
  );
  const host = createMessageConnection(
    new StreamMessageReader(requests),
    new StreamMessageWriter(responses)
  );
  const serving = serveIndexConfigStore(
    {
      // As the host's catalog binding does: a typed failure travels as the response data.
      onRequest: ((method: string, handler: (input: unknown) => Promise<unknown>) =>
        host.onRequest(method, async (input: unknown) => {
          try {
            return await handler(input);
          } catch (cause) {
            throw toBoundaryResponseError(cause, () => undefined);
          }
        })) as MessageConnection['onRequest'],
    },
    store
  );
  main.listen();
  host.listen();
  return {
    client: createIndexConfigClient(main),
    close: async () => {
      await serving.close();
      main.dispose();
      host.dispose();
      requests.destroy();
      responses.destroy();
    },
  };
}

test('a profile has no saved index config until Main writes one, then reads it back', async () => {
  const store = settings();
  const { client, close } = transport(store);
  try {
    expect(await client.indexConfig({ operation: 'read' })).toEqual({ config: null });
    const semantic = {
      ...DEFAULT_INDEX_CONFIG,
      chunking: { _tag: 'Custom', maxTokens: 768, overlap: 64 },
      mode: 'semantic',
      model: {
        dimensions: 1536,
        modelKey: 'openai::text-embedding-3-small',
      },
    } as const;
    await client.indexConfig({ config: semantic, operation: 'write' });
    expect(await client.indexConfig({ operation: 'read' })).toEqual({ config: semantic });
  } finally {
    await close();
  }
});

for (const [name, saved] of [
  ['no longer decodes', JSON.stringify({ mode: 'semantic', model: null })],
  // A config saved before local embedding models were removed (#4420).
  [
    'names a removed field',
    JSON.stringify({
      ...DEFAULT_INDEX_CONFIG,
      model: { dimensions: 384, local: {}, modelKey: 'local::granite-embedding' },
    }),
  ],
  ['is not JSON', '{"mode":'],
] as const) {
  test(`a saved value that ${name} is refused as unreadable, with its remedy, and left as it is`, async () => {
    const store = settings();
    store.values.set(INDEX_CONFIG_SETTING, saved);
    const { client, close } = transport(store);
    try {
      await expect(client.indexConfig({ operation: 'read' })).rejects.toMatchObject({
        failure: {
          category: 'configuration',
          code: INDEX_CONFIG_UNREADABLE,
          kind: 'refusal',
          remedy: INDEX_CONFIG_RESET_REMEDY,
        },
      });
      expect(store.values.get(INDEX_CONFIG_SETTING)).toBe(saved);
    } finally {
      await close();
    }
  });
}
