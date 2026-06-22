import { beforeEach, describe, expect, it, vi } from 'vitest';

const drizzleMock = vi.hoisted(() => vi.fn((client: unknown) => ({ client })));

vi.mock('drizzle-orm/pglite', () => ({
  drizzle: drizzleMock,
}));

describe('Drizzle database utilities', () => {
  beforeEach(() => {
    drizzleMock.mockClear();
  });

  it('creates Drizzle from a DbHandle raw PGlite-compatible client', async () => {
    const { drizzleFromHandle } = await import('../src/drizzle/database.js');
    const rawClient = createPGliteCompatibleClient();

    const result = drizzleFromHandle({ raw: rawClient });

    expect(result).toEqual({ client: rawClient });
    expect(drizzleMock).toHaveBeenCalledWith(rawClient);
  });

  it('does not create Drizzle from an unwrapped structural client', async () => {
    const { drizzleFromHandle } = await import('../src/drizzle/database.js');
    const directClient = createPGliteCompatibleClient();

    const result = drizzleFromHandle(directClient);

    expect(result).toBeNull();
    expect(drizzleMock).not.toHaveBeenCalled();
  });

  it('extracts the generic DB execution client from DbHandle.raw', async () => {
    const { extractDbExecutionClient, hasDbExecutionClientRaw } = await import(
      '../src/drizzle/database.js'
    );
    const rawClient = createPGliteCompatibleClient();
    const handle = { raw: rawClient };

    expect(hasDbExecutionClientRaw(handle)).toBe(true);
    expect(extractDbExecutionClient(handle)).toBe(rawClient);
  });

  it('keeps the PGlite raw helpers as compatibility aliases', async () => {
    const { extractDbExecutionClient, extractPGlite, hasDbExecutionClientRaw, hasPGliteRaw } =
      await import('../src/drizzle/database.js');
    const rawClient = createPGliteCompatibleClient();
    const handle = { raw: rawClient };

    expect(hasPGliteRaw(handle)).toBe(hasDbExecutionClientRaw(handle));
    expect(extractPGlite(handle)).toBe(extractDbExecutionClient(handle));
  });

  it('does not extract an unwrapped structural execution client', async () => {
    const { extractDbExecutionClient, hasDbExecutionClientRaw } = await import(
      '../src/drizzle/database.js'
    );
    const directClient = createPGliteCompatibleClient();

    expect(hasDbExecutionClientRaw(directClient)).toBe(false);
    expect(extractDbExecutionClient(directClient)).toBeNull();
  });

  it('returns null for partial query-only handles', async () => {
    const { drizzleFromHandle, extractDbExecutionClient } = await import(
      '../src/drizzle/database.js'
    );

    expect(extractDbExecutionClient({ query: async () => ({ rows: [] }) })).toBeNull();
    expect(drizzleFromHandle({ query: async () => ({ rows: [] }) })).toBeNull();
    expect(drizzleMock).not.toHaveBeenCalled();
  });
});

function createPGliteCompatibleClient(): {
  readonly exec: () => Promise<void>;
  readonly query: () => Promise<{ rows: readonly unknown[] }>;
  readonly transaction: <TResult>(callback: (tx: unknown) => Promise<TResult>) => Promise<TResult>;
} {
  return {
    exec: async () => undefined,
    query: async () => ({ rows: [] }),
    transaction: async <TResult>(callback: (tx: unknown) => Promise<TResult>) => await callback({}),
  };
}
