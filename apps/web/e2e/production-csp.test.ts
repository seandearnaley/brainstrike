import type { Page } from '@playwright/test';
import { getCSP } from '../src/csp-utils';
import type { WebE2ETestHooks } from '../src/web-e2e-test-hooks';
import { expect, test } from './fixtures/web-fixture';
import { waitForAppLoad } from './utils/layout-helpers';

interface SecurityPolicyViolationSnapshot {
  readonly blockedUri: string;
  readonly effectiveDirective: string;
  readonly source: 'page' | 'worker';
}

interface CspDiagnostics {
  readonly pageErrors: readonly string[];
  readonly violations: readonly SecurityPolicyViolationSnapshot[];
}

async function installProductionCsp(page: Page, baseUrl: string): Promise<void> {
  const productionCsp = getCSP('production');
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
        'content-security-policy': productionCsp,
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
  test('runs PGlite search and a real local embedding without policy violations', async ({
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
          source: 'page',
        });
      });
    });
    await installProductionCsp(page, baseURL);

    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toBe(getCSP('production'));
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
      return {
        database: await hooks.qualifyDatabaseExtensions(),
        embedding: await hooks.qualifyLocalEmbedding(),
        webgpuEmbedding: 'gpu' in navigator ? await hooks.qualifyLocalEmbedding('webgpu') : null,
      };
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
    if (qualification.webgpuEmbedding !== null) {
      expect(qualification.webgpuEmbedding).toEqual({
        device: 'webgpu',
        dimensions: 384,
        dtype: 'fp16',
        fallbackApplied: false,
        finite: true,
      });
    }
    expect(embeddingWorkerPolicies).toContain(getCSP('production'));
    expect(await collectCspDiagnostics(page, pageErrors)).toEqual({
      pageErrors: [],
      violations: [],
    });
  });
});
