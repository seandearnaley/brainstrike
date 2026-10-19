import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  startAgentHost,
} from '@brainstrike/agent-host';
import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import {
  DEFAULT_PERMISSION_POLICIES,
  type ProviderCredential,
} from '@brainstrike/assistant-contract';
import { afterEach, expect, test, vi } from 'vitest';
import { createHostProviderServices } from '../src/provider-services.js';

/**
 * BST-2174: host retirement cancels an in-flight provider read, then joins it.
 * The network wait ends at once with the request's own `host.closing`, instead
 * of holding the host's close for the read's 10 s request timeout.
 */

/** Unanswered until aborted, like a slow provider: it answers on its own only after this. */
const NETWORK_ANSWER_MS = 1500;
const PROMPT_CLOSE_MS = 1000;

const hosts: Array<{ client: HostClient; host: AgentHost; root: string }> = [];
afterEach(async () => {
  for (const { client, host, root } of hosts.splice(0)) {
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});

async function providerHost(
  stored: Record<string, ProviderCredential>,
  refresh: (provider: string) => Promise<{ ok: true }> = vi.fn()
) {
  const entered = Promise.withResolvers<AbortSignal>();
  const fetchImpl = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        entered.resolve(signal);
        const answered = setTimeout(
          () => resolve(new Response('{}', { status: 200 })),
          NETWORK_ANSWER_MS
        );
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(answered);
            reject(signal.reason);
          },
          { once: true }
        );
      })
  );
  const secrets = {
    getCredential: async (provider: string) => stored[provider] ?? null,
    getKey: async () => null,
    listProviders: async () => Object.keys(stored),
  } as unknown as SecretsService;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-provider-retirement-')));
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      providers: createHostProviderServices({
        auth: { secrets: () => secrets, verify: refresh },
        env: {},
        envFileFailures: [],
        fetchImpl: fetchImpl as typeof fetch,
      }),
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      tools: {},
    }
  );
  const client = await attachAgentHost(host.record);
  hosts.push({ client, host, root });
  return { client, entered: entered.promise, host };
}

/** Closes the host and measures how long its close took. */
async function timedClose(host: AgentHost): Promise<number> {
  const started = performance.now();
  await host.close();
  return performance.now() - started;
}

test('closing the host cancels an in-flight providers/verify, which answers host.closing', async () => {
  const { client, entered, host } = await providerHost({
    openai: { key: 'test-only-openai-key', type: 'api_key' },
  });
  const verify = client.request('providers/verify', { provider: 'openai' });
  verify.catch(() => undefined);
  const signal = await entered;

  expect(await timedClose(host)).toBeLessThan(PROMPT_CLOSE_MS);
  expect(signal.aborted).toBe(true);
  await expect(verify).rejects.toMatchObject({ code: 'host.closing' });
});

test('closing the host cancels an in-flight OpenRouter model read, which answers host.closing', async () => {
  const { client, entered, host } = await providerHost({
    openrouter: { key: 'test-only-openrouter-key', type: 'api_key' },
  });
  const read = client.request('providers/openrouter-model', { model: 'openai/gpt-5.4-mini' });
  read.catch(() => undefined);
  const signal = await entered;

  expect(await timedClose(host)).toBeLessThan(PROMPT_CLOSE_MS);
  expect(signal.aborted).toBe(true);
  await expect(read).rejects.toMatchObject({ code: 'host.closing' });
});

test("a socket's subscription verify never reaches the engine's refresh, so it cannot hold close", async () => {
  // Held forever: were it reached, close would wait on it, and the abort must never touch it.
  const refresh = vi.fn((_provider: string) => new Promise<{ ok: true }>(() => undefined));
  const { client, host } = await providerHost({}, refresh);
  // Refused by the desktop-only gate before close even begins.
  await expect(client.request('providers/verify', { provider: 'openai-codex' })).rejects.toThrow();

  expect(await timedClose(host)).toBeLessThan(PROMPT_CLOSE_MS);
  // Only the desktop's private connection reaches the refresh; host close never retires it.
  expect(refresh).not.toHaveBeenCalled();
});
