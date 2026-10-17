import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL('../..', import.meta.url));

test.each(['import', 'require'] as const)(
  'the shipped %s provider entry composes in plain Node without registering browser inference',
  async (mode) => {
    const load =
      mode === 'import'
        ? "await import('@brainstrike/agent/tool-runtime'); await import('@brainstrike/agent/mcp-client'); const runtime = await import('@brainstrike/agent/provider-runtime');"
        : "const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url); require('@brainstrike/agent/tool-runtime'); require('@brainstrike/agent/mcp-client'); const runtime = require('@brainstrike/agent/provider-runtime');";
    const { stdout } = await execute(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `${load}
const configured = runtime.resolveRuntimeConfiguration({
  model: 'qwen3',
  provider: 'lmstudio',
  providerOptions: { lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', apiToken: 'owned-test-token' } },
});
const localServer = runtime.createProvider(configured.provider, configured.authInput, configured.runtime.model, configured.runtime);
const hosted = runtime.createProvider('openai', runtime.apiKeyAuthInput('owned-test-key'), 'gpt-4o');
let localFailure;
try { runtime.createProvider('local'); } catch (cause) { localFailure = cause.code; }
process.stdout.write(JSON.stringify({
  localFailure,
  localServer: { providerId: localServer.providerId, modelId: localServer.modelId, url: localServer.url, explicitTokenRetained: localServer.apiKey === 'owned-test-token' },
  hosted: { modelId: hosted.modelId, specificationVersion: hosted.specificationVersion },
  electron: process.versions.electron ?? null,
}));`,
      ],
      { cwd }
    );
    expect(JSON.parse(stdout)).toEqual({
      electron: null,
      hosted: { modelId: 'gpt-4o', specificationVersion: 'v4' },
      // The on-device provider is refused on CAPABILITY (`capabilities.llm`),
      // before any model resolution — not by the generic init failure that used
      // to surface once transformers.js failed to register outside a browser.
      localFailure: 'mastra_agent_unsupported_provider',
      localServer: {
        explicitTokenRetained: true,
        modelId: 'qwen3',
        providerId: 'lmstudio',
        url: 'http://127.0.0.1:1234/v1',
      },
    });
  }
);
