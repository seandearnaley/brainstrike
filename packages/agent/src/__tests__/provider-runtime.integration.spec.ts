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
        ? "const runtime = await import('@brainstrike/agent/provider-runtime');"
        : "const { createRequire } = await import('node:module'); const runtime = createRequire(import.meta.url)('@brainstrike/agent/provider-runtime');";
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
  localServer: { id: localServer.id, url: localServer.url, explicitTokenRetained: localServer.apiKey === 'owned-test-token' },
  hosted: { modelId: hosted.modelId, specificationVersion: hosted.specificationVersion },
  electron: process.versions.electron ?? null,
}));`,
      ],
      { cwd }
    );
    expect(JSON.parse(stdout)).toEqual({
      electron: null,
      hosted: { modelId: 'gpt-4o', specificationVersion: 'v4' },
      localFailure: 'mastra_agent_runtime_init_failed',
      localServer: {
        explicitTokenRetained: true,
        id: 'lmstudio/qwen3',
        url: 'http://127.0.0.1:1234/v1',
      },
    });
  }
);
