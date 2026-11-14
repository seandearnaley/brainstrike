/**
 * The standalone platform's trusted model seam. Absent, `--model` resolves
 * through the canonical catalog to the real provider SDK, and no flag can name
 * a trusted model. Present (only through a trusted `--platform` module), the
 * injected model runs under its own identity, which `run.started` and each
 * `model.step` name, and no catalog model runs beside it.
 */
import { afterEach, expect, test } from 'vitest';
import {
  drainCleanup,
  refusingProvider,
  standaloneHost,
  trustedPlatformModule,
} from './fixtures/standalone-trusted-host.ts';

afterEach(drainCleanup);

test('without the seam, --model resolves through the catalog and cannot name a trusted model', {
  timeout: 120_000,
}, async () => {
  const provider = await refusingProvider();
  const host = await standaloneHost({
    BRAINSTRIKE_OPENAI_API_KEY: 'trusted-model-fixture-key',
    OPENAI_BASE_URL: provider.baseUrl,
  });
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const catalog = await host.run('openai::gpt-6-luna');
  // The real OpenAI SDK sent the catalog model's request; the stand-in refused it.
  expect(catalog.result.code).toBe(1);
  expect(provider.requests.map(({ body, url }) => ({ model: body['model'], url }))).toContainEqual({
    model: 'gpt-6-luna',
    url: '/v1/responses',
  });
  expect(catalog.rows?.find((row) => row.event.type === 'run.started')?.event).toMatchObject({
    modelId: 'openai::gpt-6-luna',
  });
  const named = await host.run('trusted-fixture::probe');
  expect(named.result.code).toBe(1);
  expect(named.result.stderr).toMatch(/explicit canonical provider::model/u);
});

test('with the seam, the injected model runs under its own identity and no catalog model runs', {
  timeout: 120_000,
}, async () => {
  const provider = await refusingProvider();
  const module = await trustedPlatformModule('trusted-fixture');
  // No provider credential: the trusted model reads none.
  const host = await standaloneHost({ OPENAI_BASE_URL: provider.baseUrl }, module);
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const trusted = await host.run('trusted-fixture::probe');
  expect(trusted.result, trusted.result.stderr).toMatchObject({ code: 0 });
  const events = (trusted.rows ?? []).map((row) => row.event);
  expect(events.find((event) => event.type === 'run.started')).toMatchObject({
    modelId: 'trusted-fixture::probe',
    snapshot: {
      configuration: {
        intent: { modelConfiguration: { model: 'probe', provider: 'trusted-fixture' } },
      },
    },
  });
  const steps = events.filter((event) => event.type === 'model.step');
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) {
    expect(step).toMatchObject({ model: { modelId: 'probe', provider: 'trusted-fixture' } });
  }
  expect(events.find((event) => event.type === 'run.finished')).toMatchObject({
    outcome: 'completed',
  });
  const catalog = await host.run('openai::gpt-6-luna');
  expect(catalog.result.code).toBe(1);
  expect(catalog.result.stderr).toMatch(/runs only the models its trusted composition supplies/u);
  expect(provider.requests).toEqual([]);
});

test('a trusted model that claims a catalog provider identity fails host start', {
  timeout: 120_000,
}, async () => {
  const host = await standaloneHost({}, await trustedPlatformModule('openai'));
  expect(host.started.code).toBe(1);
  expect(host.started.stderr).toMatch(/must not claim a catalog provider's identity/u);
});

test('a trusted composition pins the input budget below the model’s own', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture', [], { inputTokenLimit: 20_000 });
  const host = await standaloneHost({}, module);
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const pinned = await host.run('trusted-fixture::probe');
  expect(pinned.result, pinned.result.stderr).toMatchObject({ code: 0 });
  expect(pinned.rows?.find((row) => row.event.type === 'run.started')?.event).toMatchObject({
    snapshot: { configuration: { intent: { agentLoop: { inputTokenLimit: 20_000 } } } },
  });
});

test('a pin above the model’s own input budget refuses the run', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture', [], {
    inputTokenLimit: 900_000_000,
  });
  const host = await standaloneHost({}, module);
  expect(host.started, host.started.stderr).toMatchObject({ code: 0 });
  const refused = await host.run('trusted-fixture::probe');
  expect(refused.result.code).toBe(1);
  expect(refused.result.stderr).toMatch(/pinned input budget.*exceeds/u);
});

test('a pin that is not a positive whole number fails host start', {
  timeout: 120_000,
}, async () => {
  const module = await trustedPlatformModule('trusted-fixture', [], { inputTokenLimit: 0 });
  const host = await standaloneHost({}, module);
  expect(host.started.code).toBe(1);
  expect(host.started.stderr).toMatch(/pinned input budget must be a positive whole number/u);
});
