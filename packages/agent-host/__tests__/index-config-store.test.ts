// @vitest-environment node
import { PassThrough } from 'node:stream';
import { DEFAULT_INDEX_CONFIG } from '@brainstrike/assistant-contract/index-config';
import { expect, test } from 'vitest';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  createIndexConfigClient,
  INDEX_CONFIG_SETTING,
  type IndexConfigSettings,
  serveIndexConfigStore,
} from '../src/catalog/index-config-store.js';

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
  const serving = serveIndexConfigStore(host, store);
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
        dimensions: 384,
        local: { device: 'wasm', dtype: 'q8' },
        modelKey: 'transformers::Xenova/bge-small-en-v1.5',
      },
    } as const;
    await client.indexConfig({ config: semantic, operation: 'write' });
    expect(await client.indexConfig({ operation: 'read' })).toEqual({ config: semantic });
  } finally {
    await close();
  }
});

test('a saved value that no longer decodes is refused and left as it is', async () => {
  const store = settings();
  const damaged = JSON.stringify({ mode: 'semantic', model: null });
  store.values.set(INDEX_CONFIG_SETTING, damaged);
  const { client, close } = transport(store);
  try {
    await expect(client.indexConfig({ operation: 'read' })).rejects.toThrow();
    expect(store.values.get(INDEX_CONFIG_SETTING)).toBe(damaged);
  } finally {
    await close();
  }
});
