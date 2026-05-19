import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readPreloadSource(): string {
  return readFileSync(path.resolve(process.cwd(), 'src', 'preload.ts'), 'utf8');
}

describe('preload runtime contract', () => {
  it('keeps preload IPC contracts self-contained', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).not.toContain("from './db-shared'");
    expect(preloadSource).not.toContain("from './platform/logging-api-contract'");
    expect(preloadSource).toContain(
      "const DB_APPLY_MANAGED_CACHE_BATCH_CHANNEL = 'db:managed-cache:apply-batch'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_GET_PREFERENCES_CHANNEL = 'logging:get-preferences'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_PREFERENCES_UPDATED_EVENT = 'logging:preferences-updated'"
    );
  });

  it('keeps deterministic E2E local-runtime bridge responses in preload', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES');
    expect(preloadSource).toContain('createDisabledLocalRuntimeAvailability');
    expect(preloadSource).toContain('createDisabledLocalRuntimeCatalog');
  });

  it('exposes file explorer test instrumentation before renderer app mount in E2E mode', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('__brainstrike_e2e_expose_file_explorer_store__');
    expect(preloadSource).toContain('if (DESKTOP_TEST_MODE)');
  });
});
