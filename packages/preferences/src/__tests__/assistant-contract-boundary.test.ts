import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PREFERENCES_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFERENCES_PACKAGE_ROOT = path.resolve(PREFERENCES_SRC_ROOT, '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(PREFERENCES_SRC_ROOT, relativePath), 'utf8');
}

function readPackageFile(relativePath: string): string {
  return readFileSync(path.join(PREFERENCES_PACKAGE_ROOT, relativePath), 'utf8');
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

  it('reads assistant memory settings from assistant-contract instead of agent runtime packages', () => {
    expect(readSource('stores/assistant-memory-preferences-store.ts')).not.toMatch(
      /@brainstrike\/agent\/memory-settings/
    );
    expect(readSource('settings/models/assistant-memory-models.ts')).not.toMatch(
      /@brainstrike\/agent\/memory-settings/
    );
    expect(readSource('settings/models/assistant-memory-settings-section.tsx')).not.toMatch(
      /@brainstrike\/agent\/memory-settings/
    );
  });

  it('reads local-runtime contracts from assistant-contract instead of agent runtime packages', () => {
    const localRuntimeConsumers = [
      '__tests__/assistant-preferences-store.test.ts',
      '__tests__/embedding-settings-section.test.tsx',
      '__tests__/local-runtime-settings-section.test.tsx',
      'embedding/embedding-settings-section.tsx',
      'hooks/use-local-runtime-embedding-model-catalog.ts',
      'settings-test-runtime-access.ts',
      'settings/runtimes/local-runtime-settings-section.tsx',
      'settings/tools/__tests__/tool-row.test.tsx',
      'stores/assistant-preferences-store.ts',
      'testing/e2e-settings-test-overrides.ts',
    ];

    const violatingFiles = localRuntimeConsumers.filter((relativePath) =>
      /@brainstrike\/agent\/(?:client|local-runtime)/.test(readSource(relativePath))
    );

    expect(violatingFiles).toEqual([]);
  });

  it('reads built-in local LLM artifact operations from assistant-contract instead of agent runtime packages', () => {
    const packageJson = JSON.parse(readPackageFile('package.json')) as {
      dependencies?: Record<string, string>;
    };

    expect(readSource('stores/model-registry-store.ts')).not.toMatch(
      /@brainstrike\/agent\/local-llm/
    );
    expect(readSource('settings/models/model-selection-page.tsx')).not.toMatch(
      /@brainstrike\/agent\/local-llm/
    );
    expect(packageJson.dependencies).not.toHaveProperty('@brainstrike/agent');
  });
});
