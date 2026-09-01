import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const LEDGER_DIRECTORY = new URL('../conformance/expected-failures/', import.meta.url);
const LEDGER_FILES = ['2025-11-25.json', '2026-07-28.json'] as const;

interface ExpectedFailureLedger {
  readonly client: readonly string[];
}

function parseLedger(text: string, filename: string): ExpectedFailureLedger {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${filename}: official conformance expected-failure ledger must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'client') {
    throw new Error(
      `${filename}: official conformance expected-failure ledger must contain only client`
    );
  }
  const client: unknown = Reflect.get(value, 'client');
  if (!Array.isArray(client) || client.some((entry) => typeof entry !== 'string')) {
    throw new Error(
      `${filename}: official conformance client expected failures must be a string array`
    );
  }
  return { client };
}

describe('official MCP conformance expected-failure ledgers', () => {
  it('contains exactly the reviewed era ledgers', async () => {
    expect((await readdir(LEDGER_DIRECTORY)).toSorted()).toEqual(LEDGER_FILES);
  });

  it.each(LEDGER_FILES)('%s accepts no client conformance failures', async (filename) => {
    const text = await readFile(new URL(filename, LEDGER_DIRECTORY), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(parseLedger(text, filename)).toEqual({ client: [] });
  });
});
