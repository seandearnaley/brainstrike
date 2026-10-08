import { createHash, randomBytes } from 'node:crypto';
import type { McpTaskStorage } from '@brainstrike/db';
import type { McpTaskDomainRequest, McpTaskDomainRow, StateStore } from '@brainstrike/state-store';

const TEXT_ENCODER = new TextEncoder();

/** RFC 9562 UUIDv7: 48-bit Unix milliseconds, version 7, variant 10, random bits. */
function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The stored JSON text's UTF-8 size, which the SQLite CHECK bounds; hashed only when over. */
function measure(json: string | null, maxBytes: number) {
  const bytes = json === null ? 0 : TEXT_ENCODER.encode(json).length;
  return {
    bytes,
    sha256:
      json !== null && bytes > maxBytes ? createHash('sha256').update(json).digest('hex') : null,
  };
}

/**
 * The host StateStore's Tasks tables on its one writer (BST-1930 ruling B).
 * The store's writer runs each operation as one transaction; `McpTaskStore`
 * validates every input and returned row.
 */
export function stateStoreMcpTaskStorage(store: Pick<StateStore, 'mcpTasks'>): McpTaskStorage {
  const rows = async (request: McpTaskDomainRequest): Promise<readonly McpTaskDomainRow[]> =>
    (await store.mcpTasks(request)).rows;
  return {
    get: async (identity) => (await rows({ identity, operation: 'get' }))[0],
    insert: async (row, lease) => (await rows({ lease, operation: 'insert', row }))[0],
    listActive: (lease, limit) => rows({ lease, limit, operation: 'list-active' }),
    measureMetadata: async (inputMetadata, resultMetadata, maxBytes) => {
      const input = measure(inputMetadata, maxBytes);
      const result = measure(resultMetadata, maxBytes);
      return {
        inputBytes: input.bytes,
        inputSha256: input.sha256,
        resultBytes: result.bytes,
        resultSha256: result.sha256,
      };
    },
    openAuthority: (input, at) =>
      rows({ at, authorityEpoch: uuidv7(), input, operation: 'open-authority' }),
    retireAuthority: async (lease, at) => {
      await rows({ at, lease, operation: 'retire-authority' });
    },
    update: async (identity, patch, lease) =>
      (await rows({ identity, lease, operation: 'update', patch }))[0],
  };
}
