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

  it('returns null for partial query-only handles', async () => {
    const { drizzleFromHandle } = await import('../src/drizzle/database.js');

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
