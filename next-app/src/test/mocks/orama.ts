// Mock implementation of @orama/orama for testing
export const create = jest.fn().mockResolvedValue({
  add: jest.fn().mockResolvedValue(undefined),
  search: jest.fn().mockResolvedValue({
    hits: [],
    count: 0,
    elapsed: 0,
  }),
  remove: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
});

export const insertMultiple = jest.fn().mockResolvedValue(undefined);
export const load = jest.fn().mockResolvedValue({
  add: jest.fn().mockResolvedValue(undefined),
  search: jest.fn().mockResolvedValue({
    hits: [],
    count: 0,
    elapsed: 0,
  }),
  remove: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue(undefined),
});

export const save = jest.fn().mockResolvedValue(new Uint8Array());

// Add any other Orama functions that your code uses
