import { expect, test } from '@playwright/test';

interface JsonParseDiagnostic {
  inputLength: number | null;
  inputPreview: string;
  lastStorageKey: string | null;
  lastStorageValueLength: number | null;
  lastStorageValuePreview: string | null;
  message: string;
  stack: string | null;
}

interface ResponseJsonDiagnostic {
  bodyLength: number | null;
  bodyPreview: string;
  message: string;
  stack: string | null;
  url: string | null;
}

test(
  'diagnose boot-time JSON parsing failures',
  { tag: ['@smoke', '@web-smoke'] },
  async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', (error) => {
      const stack = error.stack ?? '';
      consoleErrors.push(`[pageerror] ${error.message}${stack ? `\n${stack}` : ''}`);
    });

    await page.addInitScript(() => {
      const originalParse = JSON.parse.bind(JSON);
      const originalGetItem = Storage.prototype.getItem;
      const originalResponseJson = Response.prototype.json;

      let lastStorageKey: string | null = null;
      let lastStorageValuePreview: string | null = null;
      let lastStorageValueLength: number | null = null;

      Storage.prototype.getItem = function getItem(key: string): string | null {
        const value = originalGetItem.call(this, key);
        lastStorageKey = String(key);
        if (typeof value === 'string') {
          lastStorageValueLength = value.length;
          lastStorageValuePreview = value.slice(0, 300);
        } else {
          lastStorageValueLength = null;
          lastStorageValuePreview = null;
        }
        return value;
      };

      JSON.parse = function parseWithDiagnostics(
        text: string,
        reviver?: (this: unknown, key: string, value: unknown) => unknown
      ): unknown {
        try {
          return originalParse(
            text,
            reviver as (this: unknown, key: string, value: unknown) => unknown
          );
        } catch (error) {
          const input = typeof text === 'string' ? text : String(text);
          const diagnostics: JsonParseDiagnostic = {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? null) : null,
            inputLength: typeof input === 'string' ? input.length : null,
            inputPreview: typeof input === 'string' ? input.slice(0, 500) : String(input),
            lastStorageKey,
            lastStorageValueLength,
            lastStorageValuePreview,
          };

          const globalRef = window as unknown as Record<string, unknown>;
          const existing =
            (globalRef['__jsonParseDiagnostics'] as JsonParseDiagnostic[] | undefined) ?? [];
          existing.push(diagnostics);
          globalRef['__jsonParseDiagnostics'] = existing;

          console.error('[json-parse-diagnostic]', JSON.stringify(diagnostics));
          throw error;
        }
      };

      Response.prototype.json = async function jsonWithDiagnostics(): Promise<unknown> {
        try {
          return await originalResponseJson.call(this);
        } catch (error) {
          let bodyPreview = '';
          let bodyLength: number | null = null;
          try {
            const bodyText = await this.clone().text();
            bodyLength = bodyText.length;
            bodyPreview = bodyText.slice(0, 500);
          } catch {
            // Ignore body read failures
          }

          const diagnostics: ResponseJsonDiagnostic = {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? null) : null,
            bodyLength,
            bodyPreview,
            url: this.url ?? null,
          };

          const globalRef = window as unknown as Record<string, unknown>;
          const existing =
            (globalRef['__responseJsonDiagnostics'] as ResponseJsonDiagnostic[] | undefined) ?? [];
          existing.push(diagnostics);
          globalRef['__responseJsonDiagnostics'] = existing;

          console.error('[response-json-diagnostic]', JSON.stringify(diagnostics));
          throw error;
        }
      };
    });

    await page.goto('/');
    await page.waitForLoadState('load');

    const diagnostics = await page.evaluate(() => {
      const globalRef = window as unknown as Record<string, unknown>;
      const safeKeys = (): string[] => {
        try {
          return Object.keys(localStorage);
        } catch {
          return [];
        }
      };

      return {
        parseErrors:
          (globalRef['__jsonParseDiagnostics'] as JsonParseDiagnostic[] | undefined) ?? [],
        responseErrors:
          (globalRef['__responseJsonDiagnostics'] as ResponseJsonDiagnostic[] | undefined) ?? [],
        storageKeys: safeKeys(),
      };
    });

    await testInfo.attach('json-parse-diagnostics.json', {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: 'application/json',
    });

    if (consoleErrors.length > 0) {
      await testInfo.attach('json-parse-console-errors.txt', {
        body: consoleErrors.join('\n'),
        contentType: 'text/plain',
      });
    }

    expect(diagnostics.parseErrors, 'Unexpected JSON.parse failures detected').toEqual([]);
    expect(diagnostics.responseErrors, 'Unexpected Response.json failures detected').toEqual([]);
  }
);
