import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function resolveDistModule(moduleName: string): string {
  return path.resolve(import.meta.dirname, '..', '..', 'dist', moduleName);
}

describe('built logger modules', () => {
  it('shares logger state between root exports and logging initializer', async () => {
    const rootUtils = await import(pathToFileURL(resolveDistModule('index.mjs')).href);
    const loggerModule = await import(pathToFileURL(resolveDistModule('logger.mjs')).href);
    const loggingInitializerModule = await import(
      pathToFileURL(resolveDistModule('logging-initializer.mjs')).href
    );

    loggerModule.resetLogger();

    const records: string[] = [];
    const removeListener = rootUtils.addLogListener((record: { message?: string }) => {
      if (record.message) {
        records.push(record.message);
      }
    });

    try {
      loggingInitializerModule.initializeLogging({
        consoleLevel: loggerModule.LogLevel.DEBUG,
        level: loggerModule.LogLevel.DEBUG,
        runtime: 'browser',
      });

      rootUtils.debug('dist initializer marker');

      expect(records).toContain('dist initializer marker');
    } finally {
      removeListener();
      loggerModule.resetLogger();
    }
  });

  it('shares logger state between root exports and logging preferences', async () => {
    const rootUtils = await import(pathToFileURL(resolveDistModule('index.mjs')).href);
    const loggerModule = await import(pathToFileURL(resolveDistModule('logger.mjs')).href);
    const loggingPreferencesModule = await import(
      pathToFileURL(resolveDistModule('logging-preferences.mjs')).href
    );

    loggerModule.resetLogger();

    const records: string[] = [];
    const removeListener = rootUtils.addLogListener((record: { message?: string }) => {
      if (record.message) {
        records.push(record.message);
      }
    });

    try {
      loggingPreferencesModule.applyLoggingPreferences(
        loggingPreferencesModule.createDefaultLoggingPreferences({
          consoleLevel: loggerModule.LogLevel.DEBUG,
          level: loggerModule.LogLevel.DEBUG,
        }),
        'browser'
      );

      rootUtils.debug('dist preferences marker');

      expect(records).toContain('dist preferences marker');
    } finally {
      removeListener();
      loggerModule.resetLogger();
    }
  });
});
