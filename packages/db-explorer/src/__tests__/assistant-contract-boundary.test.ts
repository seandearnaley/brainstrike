import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB_EXPLORER_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(DB_EXPLORER_SRC_ROOT, relativePath), 'utf8');
}

describe('db-explorer assistant contract boundary', () => {
  it('reads local-runtime contracts from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('hooks/use-available-models.ts')).not.toMatch(
      /@brainstrike\/agent\/(?:client|local-runtime)/
    );
    expect(readSource('hooks/__tests__/use-available-models.test.ts')).not.toMatch(
      /@brainstrike\/agent\/(?:client|local-runtime)/
    );
  });

  it('reads context packing contracts from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('hooks/use-context-packer.ts')).not.toMatch(
      /@brainstrike\/agent\/context-packer/
    );
    expect(readSource('utils/context-packer-utils.ts')).not.toMatch(
      /@brainstrike\/agent\/context-packer/
    );
  });
});
