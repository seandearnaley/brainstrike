// Sourced from the shared builder rather than the app's `../src/csp-utils`
// wrapper: this spec graph is ESM (see e2e/package.json), while apps/web has no
// `"type"`, so a value import reaching into apps/web/src is CommonJS-transpiled
// inside an ESM graph and fails to load. `getCSP(env)` is a one-line wrapper that
// only pins the target, so calling the builder with 'web' is the same string.
import { getContentSecurityPolicy } from '@brainstrike/platform-utils';
import type { Page } from '@playwright/test';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { expect, test } from './fixtures/web-fixture';
import { waitForAppLoad } from './utils/layout-helpers';

const PRODUCTION_CSP = getContentSecurityPolicy('production', 'web');

interface SecurityPolicyViolationSnapshot {
  readonly blockedUri: string;
  readonly effectiveDirective: string;
  readonly lineNumber?: number;
  readonly source: 'page' | 'worker';
  readonly sourceFile?: string;
}

interface CspDiagnostics {
  readonly pageErrors: readonly string[];
  readonly violations: readonly SecurityPolicyViolationSnapshot[];
}

async function installProductionCsp(page: Page, baseUrl: string): Promise<void> {
  const appOrigin = new URL(baseUrl).origin;
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== appOrigin) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      headers: {
        ...response.headers(),
        'content-security-policy': PRODUCTION_CSP,
      },
      response,
    });
  });
}

async function collectCspDiagnostics(
  page: Page,
  pageErrors: readonly string[]
): Promise<CspDiagnostics> {
  const pageViolations = await page.evaluate(
    () =>
      (
        window as unknown as {
          __brainstrikeCspViolations__?: SecurityPolicyViolationSnapshot[];
        }
      ).__brainstrikeCspViolations__ ?? []
  );
  return {
    pageErrors,
    violations: pageViolations,
  };
}

test.describe('Production CSP qualification', () => {
  test('runs PGlite search and a real local embedding without policy violations @stateful @web-production-csp', async ({
    baseURL,
    page,
  }) => {
    test.setTimeout(180_000);
    if (!baseURL) {
      throw new Error('Production CSP qualification requires a Playwright baseURL');
    }
    const pageErrors: string[] = [];
    const embeddingWorkerPolicies: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
    page.on('response', (response) => {
      if (response.url().includes('/assets/embedding.worker-')) {
        const csp = response.headers()['content-security-policy'];
        if (csp) {
          embeddingWorkerPolicies.push(csp);
        }
      }
    });
    await page.addInitScript(() => {
      const browserWindow = window as unknown as {
        __brainstrikeCspViolations__?: SecurityPolicyViolationSnapshot[];
      };
      browserWindow.__brainstrikeCspViolations__ = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        browserWindow.__brainstrikeCspViolations__?.push({
          blockedUri: event.blockedURI,
          effectiveDirective: event.effectiveDirective,
          lineNumber: event.lineNumber,
          source: 'page',
          sourceFile: event.sourceFile,
        });
      });
    });
    await installProductionCsp(page, baseURL);

    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toBe(PRODUCTION_CSP);
    await waitForAppLoad(page);

    const qualification = await page.evaluate(async () => {
      const hooks = (
        window as unknown as {
          __brainstrikeWebE2ETestHooks__?: WebE2ETestHooks;
        }
      ).__brainstrikeWebE2ETestHooks__;
      if (!hooks) {
        throw new Error('Web E2E hooks are not installed');
      }
      const database = await hooks.qualifyDatabaseExtensions();
      const embedding = await hooks.qualifyLocalEmbedding();
      const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter() : null;
      if (!adapter) {
        return { database, embedding, webgpu: { kind: 'unavailable' as const } };
      }
      if (adapter.features.has('shader-f16')) {
        return {
          database,
          embedding,
          webgpu: {
            kind: 'supported' as const,
            result: await hooks.qualifyLocalEmbedding('webgpu'),
          },
        };
      }
      // An exposed WebGPU API does not imply fp16 support. Exercise strict
      // rejection instead of accepting a WASM or dtype fallback.
      try {
        await hooks.qualifyLocalEmbedding('webgpu');
      } catch (error) {
        return {
          database,
          embedding,
          webgpu: {
            error: error instanceof Error ? error.message : String(error),
            kind: 'refused' as const,
          },
        };
      }
      throw new Error('An fp16 request unexpectedly succeeded without shader-f16 support');
    });

    expect(qualification.database).toMatchObject({
      extensions: ['pg_textsearch', 'pg_trgm', 'vector'],
      fullTextMatch: true,
      vectorDistance: 0,
    });
    expect(qualification.database.bm25Score).toBeGreaterThan(0);
    expect(qualification.embedding).toEqual({
      device: 'wasm',
      dimensions: 384,
      dtype: 'q4',
      fallbackApplied: false,
      finite: true,
    });
    if (qualification.webgpu.kind === 'refused') {
      expect(qualification.webgpu.error).toContain('The device (webgpu) does not support fp16.');
    }
    if (qualification.webgpu.kind === 'supported') {
      expect(qualification.webgpu.result).toEqual({
        device: 'webgpu',
        dimensions: 384,
        dtype: 'fp16',
        fallbackApplied: false,
        finite: true,
      });
    }
    expect(embeddingWorkerPolicies).toContain(PRODUCTION_CSP);
    expect(await collectCspDiagnostics(page, pageErrors)).toEqual({
      pageErrors: [],
      violations: [],
    });
  });
});
