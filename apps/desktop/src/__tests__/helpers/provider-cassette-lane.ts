/**
 * The host-level provider cassette lane: one scenario on a fresh standalone
 * host, either replayed from its cassette through the model-provider shim or
 * recorded through the cassette recorder. Both derive the settled
 * conversation's shape and invariant violations (./conversation-shape.ts).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { providerEnvKeys } from '@brainstrike/assistant-contract/provider-metadata';
import {
  assembleProviderCassette,
  encodeProviderCassette,
  PROVIDER_CASSETTE_UPSTREAMS,
  type ProviderCassette,
  type ProviderCassetteFinding,
  type ProviderCassetteKnob,
  providerCassetteFindings,
  startProviderCassetteRecorder,
} from '@brainstrike/test-utils/provider-cassette';
import { isSettledConversation } from '../../../e2e/utils/conversation-invariants';
import {
  type ModelProviderRefusal,
  resolveProviderEgressEnvironment,
  startModelProviderShim,
} from '../../../e2e/utils/model-provider-shim';
import {
  type ProviderCassetteScenario,
  providerOf,
} from '../../../e2e/utils/provider-cassette-scenarios';
import { type ConversationShape, conversationShape } from './conversation-shape';
import {
  createStandaloneWorkspace,
  pollUntil,
  startStandaloneProviderHost,
} from './standalone-provider-host';

const WORKSPACE_NAME = 'cassette-workspace';
const WORKSPACE_PLACEHOLDER = '<workspace>';
const KNOBS = Object.keys(PROVIDER_CASSETTE_UPSTREAMS) as ProviderCassetteKnob[];
/** A provider refuses this as it refuses any unknown key; it is no key's format. */
const INVALID_KEY = 'provider-cassette-invalid-key';
/** The key a replayed host holds: the shim never reads it. */
const REPLAY_KEY = 'provider-cassette-replay';
/** A provider stream has sent answer text, on any of the three wires: a Stop now cuts it off. */
function streamsText(body: string): boolean {
  return /"type":"response\.output_text\.delta"|"type":"text_delta"|"delta":\{[^}]*"content":"[^"]/u.test(
    body
  );
}

export interface ScenarioResult {
  readonly shape: ConversationShape;
  readonly violations: ReturnType<typeof conversationShape>['violations'];
}

export interface ReplayResult extends ScenarioResult {
  readonly refusals: readonly ModelProviderRefusal[];
  /** Keys of recorded exchanges no request claimed. */
  readonly unserved: readonly string[];
}

function credentialEnvironment(
  scenario: ProviderCassetteScenario,
  key: string
): Record<string, string> {
  const [override] = providerEnvKeys(providerOf(scenario));
  if (!override) {
    throw new Error(`${scenario.id}: its provider has no credential env name`);
  }
  return { [override]: key };
}

/** The recorder's own key for the scenario's provider, read from this process's shell only. */
export function recorderKey(scenario: ProviderCassetteScenario): string {
  if (scenario.credential === 'invalid') {
    return INVALID_KEY;
  }
  const names = providerEnvKeys(providerOf(scenario));
  const key = names.map((name) => process.env[name]).find((value) => value?.trim());
  if (!key) {
    throw new Error(`Recording ${scenario.id} needs ${names.join(' or ')} in this shell.`);
  }
  return key;
}

/**
 * Runs the scenario on a fresh standalone host and derives its settled shape.
 * `streaming` says the run's answer is streaming, so a Stop now cuts it off.
 */
async function drive(
  scenario: ProviderCassetteScenario,
  environment: Readonly<Record<string, string>>,
  workspace: string,
  streaming: () => boolean
): Promise<ScenarioResult> {
  const host = await startStandaloneProviderHost({
    environment: { ['MASTRA_OFFLINE']: 'true', ...environment },
    workspace,
  });
  try {
    let threadId: string;
    if (scenario.stop) {
      const started = await host.startRun(scenario.prompt, scenario.model);
      threadId = started.threadId;
      await pollUntil(async () => streaming(), Boolean);
      const stopped = await host.cli(['run', 'stop', '--thread', threadId, '--run', started.runId]);
      if (stopped.code !== 0) {
        throw new Error(`run stop failed: ${stopped.stderr}`);
      }
    } else {
      threadId = (await host.run(scenario.prompt, scenario.model)).threadId;
    }
    const read = async () => {
      const ids = await host.children(threadId);
      return {
        children: await Promise.all(
          ids.map(async (id) => ({ rows: await host.rows(id), threadId: id }))
        ),
        parent: { rows: await host.rows(threadId), threadId },
      };
    };
    const conversation = await pollUntil(read, ({ children, parent }) =>
      isSettledConversation(
        scenario.children ?? 0,
        parent.rows,
        children.map(({ rows }) => rows)
      )
    );
    return conversationShape(conversation);
  } finally {
    await host.close();
  }
}

/** Replays `cassette` through the shim into a fresh standalone host. */
export async function replayScenario(
  scenario: ProviderCassetteScenario,
  cassette: ProviderCassette
): Promise<ReplayResult> {
  const { remove, workspace } = await createStandaloneWorkspace(WORKSPACE_NAME, scenario.files);
  const shim = await startModelProviderShim({
    cassette,
    ...(scenario.pace === undefined ? {} : { pace: scenario.pace }),
    substitutions: [{ from: workspace, to: WORKSPACE_PLACEHOLDER }],
  });
  try {
    const result = await drive(
      scenario,
      {
        ...resolveProviderEgressEnvironment(shim, []),
        ...credentialEnvironment(scenario, REPLAY_KEY),
      },
      workspace,
      () => shim.heldExchanges() > 0
    );
    return {
      ...result,
      refusals: shim.refusals(),
      unserved: shim.unservedExchanges().map((exchange) => JSON.stringify(exchange.key)),
    };
  } finally {
    await shim.close();
    await remove();
  }
}

export interface RecordedScenario extends ScenarioResult {
  readonly cassette: ProviderCassette;
  readonly findings: readonly ProviderCassetteFinding[];
  /** The repository secret scanner's report on the encoded cassette; empty when clean. */
  readonly secretScan: string;
}

/** The repository's own secret scanner (`--files`), run over the encoded cassette outside the repo. */
const SECRET_SCAN = resolve(import.meta.dirname, '../../../../../scripts/secret-scan.mjs');

async function secretScan(cassette: ProviderCassette): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bs-cassette-scan-'));
  const file = join(directory, `${cassette.scenario}.json`);
  try {
    await writeFile(file, encodeProviderCassette(cassette));
    return await new Promise((done, fail) => {
      execFile(process.execPath, [SECRET_SCAN, '--files', file], (cause, stdout, stderr) => {
        if (!cause) {
          done('');
        } else if (typeof cause.code === 'number') {
          done(`${stdout}${stderr}`.trim() || `secret scan exited ${cause.code}`);
        } else {
          fail(cause);
        }
      });
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/**
 * Runs the scenario against real providers (or `upstreams`) through the
 * recorder, holding `key`. Nothing is written here: the caller keeps the
 * cassette only once its findings are empty and it replays to the same shape.
 */
export async function recordScenario(
  scenario: ProviderCassetteScenario,
  key: string,
  upstreams?: Readonly<Record<ProviderCassetteKnob, string>>
): Promise<RecordedScenario> {
  const { remove, workspace } = await createStandaloneWorkspace(WORKSPACE_NAME, scenario.files);
  const recorder = await startProviderCassetteRecorder({
    substitutions: [{ from: workspace, to: WORKSPACE_PLACEHOLDER }],
    ...(upstreams ? { upstreams } : {}),
  });
  try {
    const result = await drive(
      scenario,
      {
        ...Object.fromEntries(KNOBS.map((knob) => [knob, recorder.baseUrlFor(knob)])),
        ...credentialEnvironment(scenario, key),
      },
      workspace,
      () => recorder.recording.inFlightBodies().some(streamsText)
    );
    await pollUntil(
      async () => recorder.recording.inFlight(),
      (count) => count === 0
    );
    const cassette = assembleProviderCassette({
      exchanges: recorder.recording.exchanges(),
      recordedAt: new Date().toISOString(),
      scenario: scenario.id,
    });
    const findings = providerCassetteFindings(cassette, [
      { rule: 'home-directory', value: homedir() },
      { rule: 'user-name', value: userInfo().username },
      { rule: 'workspace-path', value: workspace },
      { rule: 'temporary-directory', value: tmpdir() },
      { rule: 'recorder-credential', value: key },
    ]);
    return { ...result, cassette, findings, secretScan: await secretScan(cassette) };
  } finally {
    await recorder.close();
    await remove();
  }
}
