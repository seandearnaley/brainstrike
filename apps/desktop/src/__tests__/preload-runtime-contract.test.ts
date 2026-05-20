import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL } from '../desktop-platform-diagnostics';
import { LOGGING_API_CHANNELS } from '../platform/logging-api-contract';

function readPreloadSource(): string {
  return readFileSync(path.resolve(process.cwd(), 'src', 'preload.ts'), 'utf8');
}

function extractPreloadStringConstant(source: string, constantName: string): string {
  const escapedConstantName = constantName.replaceAll('$', String.raw`\$`);
  const match = source.match(
    new RegExp(String.raw`const\s+${escapedConstantName}\s*=\s*['"]([^'"]+)['"]\s+as\s+const`)
  );
  if (!match?.[1]) {
    throw new Error(`Missing preload constant ${constantName}.`);
  }
  return match[1];
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
      "const LOGGING_SET_PREFERENCES_CHANNEL = 'logging:set-preferences'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_SELECT_DESTINATION_CHANNEL = 'logging:select-destination'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_OPEN_DESTINATION_CHANNEL = 'logging:open-destination'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_GET_BUFFERED_LOGS_CHANNEL = 'logging:get-buffered-logs'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_INGEST_BUFFERED_RECORD_CHANNEL = 'logging:ingest-buffered-record'"
    );
    expect(preloadSource).toContain(
      "const LOGGING_PREFERENCES_UPDATED_EVENT = 'logging:preferences-updated'"
    );
    expect(preloadSource).toContain(
      "const DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL = 'desktop-diagnostics:get-snapshot'"
    );
  });

  it('keeps preload logging literals in parity with the platform logging contract', () => {
    const preloadSource = readPreloadSource();

    expect({
      getBufferedLogs: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_GET_BUFFERED_LOGS_CHANNEL'
      ),
      getPreferences: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_GET_PREFERENCES_CHANNEL'
      ),
      ingestBufferedRecord: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_INGEST_BUFFERED_RECORD_CHANNEL'
      ),
      openDestination: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_OPEN_DESTINATION_CHANNEL'
      ),
      preferencesUpdated: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_PREFERENCES_UPDATED_EVENT'
      ),
      selectDestination: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_SELECT_DESTINATION_CHANNEL'
      ),
      setPreferences: extractPreloadStringConstant(
        preloadSource,
        'LOGGING_SET_PREFERENCES_CHANNEL'
      ),
    }).toEqual(LOGGING_API_CHANNELS);

    const preloadWithoutConstantDefinitions = preloadSource.replaceAll(
      /const\s+LOGGING_[A-Z_]+_(?:CHANNEL|EVENT)\s*=\s*['"]logging:[^'"]+['"]\s+as\s+const;/g,
      ''
    );
    expect(preloadWithoutConstantDefinitions).not.toMatch(/['"]logging:[^'"]+['"]/);
  });

  it('keeps deterministic E2E local-runtime bridge responses in preload', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES');
    expect(preloadSource).toContain('createDisabledLocalRuntimeAvailability');
    expect(preloadSource).toContain('createDisabledLocalRuntimeCatalog');
  });

  it('keeps preload desktop diagnostics literal in parity with the platform diagnostics contract', () => {
    const preloadSource = readPreloadSource();

    expect(
      extractPreloadStringConstant(preloadSource, 'DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL')
    ).toBe(DESKTOP_DIAGNOSTICS_GET_SNAPSHOT_CHANNEL);
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('desktopDiagnostics'");
  });

  it('exposes file explorer test instrumentation before renderer app mount in E2E mode', () => {
    const preloadSource = readPreloadSource();

    expect(preloadSource).toContain('__brainstrike_e2e_expose_file_explorer_store__');
    expect(preloadSource).toContain('if (DESKTOP_TEST_MODE)');
  });
});
