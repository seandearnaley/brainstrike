import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PREFERENCES_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(PREFERENCES_SRC_ROOT, relativePath), 'utf8');
}

describe('preferences assistant contract boundary', () => {
  it('reads provider metadata from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('stores/assistant-preferences-store.ts')).not.toMatch(
      /@brainstrike\/agent\/provider-metadata/
    );
    expect(readSource('embedding/embedding-settings-section.tsx')).not.toMatch(
      /@brainstrike\/agent\/provider-metadata/
    );
    expect(readSource('settings/secrets/api-keys-settings.tsx')).not.toMatch(
      /@brainstrike\/agent\/provider-metadata/
    );
  });

  it('reads native tool metadata from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('stores/native-tool-preferences-store.ts')).not.toMatch(
      /@brainstrike\/agent\/tool-metadata/
    );
    expect(readSource('settings/tools/tool-playground.tsx')).not.toMatch(
      /@brainstrike\/agent\/tool-metadata/
    );
    expect(readSource('settings/tools/tool-row.tsx')).not.toMatch(
      /@brainstrike\/agent\/tool-metadata/
    );
  });
});
