// Mock implementation of @orama/orama for testing
import { vi } from 'vitest';

export const create = vi.fn().mockResolvedValue({
  add: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue({
    hits: [],
    count: 0,
    elapsed: 0,
  }),
  remove: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
});

export const insertMultiple = vi.fn().mockResolvedValue(undefined);
export const load = vi.fn().mockResolvedValue({
  add: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue({
    hits: [],
    count: 0,
    elapsed: 0,
  }),
  remove: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
});

export const save = vi.fn().mockResolvedValue(new Uint8Array());

// Add any other Orama functions that your code uses
