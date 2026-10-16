/**
 * Provider cassettes on the real host: each scenario's recorded provider
 * exchanges replay byte for byte through the model-provider shim, the real
 * provider SDKs parse them inside the standalone host, and the committed log
 * and the renderer projection of it must keep every conversation invariant.
 * The derived shape is snapshotted; text never is.
 *
 * Record mode (docs/agents/provider-cassettes.md) runs the same scenario
 * against the real provider through the cassette recorder, with the key the
 * person recording exports in their own shell, and keeps the cassette only if
 * it leaks nothing, shows the behavior the scenario exists for, keeps every
 * invariant and replays to the conversation it recorded.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  encodeProviderCassette,
  type ProviderCassette,
} from '@brainstrike/test-utils/provider-cassette';
import { describe, expect, test } from 'vitest';
import {
  cassetteFile,
  describeRecording,
  PROVIDER_CASSETTE_SCENARIOS,
  type ProviderCassetteScenario,
  readScenarioCassette,
} from '../../e2e/utils/provider-cassette-scenarios';
import { recorderKey, recordScenario, replayScenario } from './helpers/provider-cassette-lane';

/** A scenario id, or `all`: record instead of replay. */
const RECORD = process.env['BRAINSTRIKE_PROVIDER_CASSETTE_RECORD'];

function recording(scenario: ProviderCassetteScenario): boolean {
  return RECORD === 'all' || RECORD === scenario.id;
}

async function record(scenario: ProviderCassetteScenario): Promise<ProviderCassette> {
  const recorded = await recordScenario(scenario, recorderKey(scenario));
  expect(
    recorded.findings,
    'a recording that holds a local path or the key is never saved'
  ).toEqual([]);
  expect(recorded.secretScan, 'a recording that trips the secret scanner is never saved').toBe('');
  if (scenario.exhibits && !scenario.exhibits.holds(recorded.cassette)) {
    throw new Error(
      `${scenario.id}: the recording shows no ${scenario.exhibits.behavior}; not saved. Record it again.\n${describeRecording(recorded.cassette)}`
    );
  }
  expect(recorded.violations, 'a recording that breaks an invariant is never saved').toEqual([]);
  const replayed = await replayScenario(scenario, recorded.cassette);
  expect(replayed.shape, 'a recording must replay to the conversation it recorded').toEqual(
    recorded.shape
  );
  await mkdir(dirname(cassetteFile(scenario)), { recursive: true });
  await writeFile(cassetteFile(scenario), encodeProviderCassette(recorded.cassette));
  return recorded.cassette;
}

describe.each(PROVIDER_CASSETTE_SCENARIOS)('provider cassette $id', (scenario) => {
  test(`${recording(scenario) ? 'records' : 'replays'} and keeps every invariant${scenario.guards ? ` (guards ${scenario.guards})` : ''}`, {
    timeout: 300_000,
  }, async () => {
    const cassette = recording(scenario) ? await record(scenario) : readScenarioCassette(scenario);
    const { refusals, shape, unserved, violations } = await replayScenario(scenario, cassette);
    expect(refusals).toEqual([]);
    expect(unserved).toEqual([]);
    expect(violations).toEqual([]);
    expect(shape).toMatchSnapshot();
  });
});
