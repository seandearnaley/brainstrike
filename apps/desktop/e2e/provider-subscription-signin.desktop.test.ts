import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test as base, expect } from './fixtures/electron-fixture';

const SLOT = 'openai-codex';
const USER_CODE = 'E2E-CODE-7Q';
const ACCOUNT_ID = 'acct-e2e-signin';
const REFRESH_TOKEN = 'e2e-issuer-refresh-token';

interface IssuerRequest {
  readonly method: string;
  readonly path: string;
}

interface FakeCodexIssuer {
  close(): Promise<void>;
  readonly origin: string;
  readonly requests: IssuerRequest[];
}

/** An unsigned JWT carrying the Codex account claim, as the issuer's tokens do. */
function codexToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } }),
    'e2e-signature',
  ].join('.');
}

/**
 * A loopback stand-in for the Codex device sign-in: start, one pending poll,
 * then an authorization code the host exchanges for a token pair. Anything
 * else is recorded and refused.
 */
async function startFakeCodexIssuer(): Promise<FakeCodexIssuer> {
  const requests: IssuerRequest[] = [];
  let polls = 0;
  const server = http.createServer((request, response) => {
    const route = `${request.method ?? ''} ${request.url ?? ''}`;
    requests.push({ method: request.method ?? '', path: request.url ?? '' });
    request.resume();
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    switch (route) {
      case 'POST /api/accounts/deviceauth/usercode':
        json(200, { device_auth_id: 'e2e-device-auth', interval: '1', user_code: USER_CODE });
        return;
      case 'POST /api/accounts/deviceauth/token':
        polls += 1;
        // Codex reports "not yet authorized" as a bare 403.
        if (polls === 1) {
          json(403, {});
          return;
        }
        json(200, { authorization_code: 'e2e-authorization-code', code_verifier: 'e2e-verifier' });
        return;
      case 'POST /oauth/token':
        json(200, {
          access_token: codexToken(),
          expires_in: 3600,
          id_token: codexToken(),
          refresh_token: REFRESH_TOKEN,
          token_type: 'Bearer',
        });
        return;
      default:
        json(404, { error: 'unexpected_e2e_issuer_request' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    origin: `http://127.0.0.1:${port}`,
    requests,
  };
}

const test = base.extend<{ codexIssuer: FakeCodexIssuer }>({
  codexIssuer: async ({}, use) => {
    const issuer = await startFakeCodexIssuer();
    try {
      await use(issuer);
    } finally {
      await issuer.close();
    }
  },
  // The launch's egress boundary stands in for the Codex issuer on loopback.
  electronEnv: async ({ codexIssuer }, use) => {
    await use({ ['BRAINSTRIKE_E2E_OPENAI_CODEX_ISSUER']: codexIssuer.origin });
  },
});

async function openSubscriptionCard(window: Page): Promise<void> {
  const categories = window.getByRole('navigation', { name: 'Settings categories' });
  await expect(categories).toBeVisible();
  await categories.getByRole('button', { name: /^Providers$/i }).click();
  await expect(window.getByTestId('settings-category-providers')).toBeVisible();
  // Settings may keep a card expanded across leaving and reopening it.
  const toggle = window.getByTestId(`provider-card-toggle-${SLOT}`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(window.getByTestId(`credential-row-${SLOT}`)).toBeVisible();
}

/**
 * Settings drives the subscription sign-in held by the agent host: the visible
 * window's connect, status and disconnect reach the host's one OAuth engine
 * through Main's private desktop client, the host alone writes the sign-in to
 * the profile store, and no token reaches the page.
 */
test('Settings connects, reports and disconnects the subscription sign-in held by the host', async ({
  codexIssuer,
  electron,
  homePage,
  window,
}) => {
  test.setTimeout(120_000);
  const store = path.join(electron.getUserDataDir(), 'brainstrike-credentials.json');
  const readStore = async (): Promise<string> => {
    try {
      return await readFile(store, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  };

  await homePage.openSettings();
  await openSubscriptionCard(window);
  // The host reports no sign-in for the fresh profile.
  await expect(window.getByTestId(`credential-oauth-device-${SLOT}`)).toBeVisible();

  await window.getByTestId(`credential-oauth-device-${SLOT}`).click();
  await expect(window.getByTestId(`credential-oauth-user-code-${SLOT}`)).toContainText(USER_CODE);
  // The host's engine polls, exchanges the code and reports the account.
  await expect(window.getByTestId(`credential-oauth-account-${SLOT}`)).toHaveText(ACCOUNT_ID, {
    timeout: 30_000,
  });
  expect(await readStore()).toContain(REFRESH_TOKEN);
  expect(await window.content()).not.toContain(REFRESH_TOKEN);

  // Status survives leaving and reopening Settings: it is the host's fact.
  await homePage.leaveSettings();
  await homePage.openSettings();
  await openSubscriptionCard(window);
  await expect(window.getByTestId(`credential-oauth-account-${SLOT}`)).toHaveText(ACCOUNT_ID);

  await window.getByTestId(`credential-oauth-disconnect-${SLOT}`).click();
  await expect(window.getByTestId(`credential-oauth-device-${SLOT}`)).toBeVisible();
  expect(await readStore()).not.toContain(REFRESH_TOKEN);

  expect(codexIssuer.requests.map(({ method, path: route }) => `${method} ${route}`)).toEqual([
    'POST /api/accounts/deviceauth/usercode',
    'POST /api/accounts/deviceauth/token',
    'POST /api/accounts/deviceauth/token',
    'POST /oauth/token',
  ]);
});
