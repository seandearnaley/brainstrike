/**
 * Owner-only: record a task's provider cassette (docs/agents/agent-evals.md).
 * It makes paid provider calls with the key the owner exported in their own
 * shell, so agents and CI never run it. It reuses the provider-cassette
 * recorder and the repository secret scanner, and writes the cassette only if
 * it holds no local path or key, the scanner finds nothing, and it replays to
 * the verdict it recorded with every exchange claimed.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assembleProviderCassette,
  encodeProviderCassette,
  PROVIDER_CASSETTE_UPSTREAMS,
  type ProviderCassetteKnob,
  type ProviderCassetteRecorder,
  providerCassetteFindings,
  startProviderCassetteRecorder,
} from '@brainstrike/test-utils/provider-cassette';
import { startProviderBoundary } from './provider-boundary.js';
import { attemptEvalTask, providerCredentialEnvNames } from './runner.js';
import { loadEvalTask } from './task.js';

const SECRET_SCAN = resolve(import.meta.dirname, '../../../scripts/secret-scan.mjs');
const KNOBS = Object.keys(PROVIDER_CASSETTE_UPSTREAMS) as ProviderCassetteKnob[];

/** The repository's own secret scanner over the encoded cassette, outside the repo; empty when clean. */
async function secretScan(encoded: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bs-agent-eval-scan-'));
  const file = join(directory, 'cassette.json');
  try {
    await writeFile(file, encoded);
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

/** Records `taskId` against `model` and writes `tasks/<id>/cassette.json` and its `task.json`. */
export async function recordEvalCassette(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly model: string;
  readonly taskDir: string;
}): Promise<string> {
  if (options.env['CI']) {
    throw new Error('Recording makes paid provider calls; it never runs in CI');
  }
  const names = providerCredentialEnvNames(options.model);
  const [name] = names;
  const key = names.map((candidate) => options.env[candidate]).find((value) => value?.trim());
  if (!(name && key)) {
    throw new Error(`Recording ${options.model} needs ${names.join(' or ')} in this shell`);
  }
  const loaded = await loadEvalTask(options.taskDir);
  const recordedTask = { ...loaded.task, model: options.model };
  const recording = { ...loaded, task: recordedTask };
  let recorder: ProviderCassetteRecorder | undefined;
  const recorded = await attemptEvalTask(recording, {
    batch: `record-${loaded.task.id}`,
    credential: { [name]: key },
    egress: async (substitutions) => {
      const started = await startProviderCassetteRecorder({ substitutions });
      recorder = started;
      return {
        close: started.close,
        env: Object.fromEntries(KNOBS.map((knob) => [knob, started.baseUrlFor(knob)])) as Record<
          ProviderCassetteKnob,
          string
        >,
        refusals: () => [],
        unserved: () => [],
      };
    },
    mode: 'live',
  });
  if (!recorder) {
    throw new Error(`The recording never started: ${recorded.result.reason ?? 'no reason'}`);
  }
  if (recorder.recording.inFlight() !== 0) {
    throw new Error('The recording still has provider requests in flight; not saved');
  }
  const cassette = assembleProviderCassette({
    exchanges: recorder.recording.exchanges(),
    recordedAt: new Date().toISOString(),
    scenario: `agent-evals/${loaded.task.id}`,
  });
  const findings = providerCassetteFindings(cassette, [
    { bounded: true, rule: 'home-directory', value: homedir() },
    { rule: 'recorder-credential', value: key },
  ]);
  if (findings.length > 0) {
    throw new Error(
      `The recording holds identifying literals; not saved: ${JSON.stringify(findings)}`
    );
  }
  const encoded = encodeProviderCassette(cassette);
  const scanned = await secretScan(encoded);
  if (scanned) {
    throw new Error(`The secret scanner flagged the recording; not saved:\n${scanned}`);
  }
  const replayed = await attemptEvalTask(recording, {
    batch: `record-check-${loaded.task.id}`,
    egress: (substitutions) => startProviderBoundary({ cassette, substitutions }),
    mode: 'replay',
  });
  const boundary = replayed.attempt.boundary;
  if (
    !boundary ||
    boundary.refusals.length > 0 ||
    boundary.unserved.length > 0 ||
    replayed.result.verdict !== recorded.result.verdict ||
    replayed.result.pass !== recorded.result.pass
  ) {
    throw new Error(
      `The recording does not replay to what it recorded; not saved. Recorded: ${JSON.stringify(recorded.result)} Replayed: ${JSON.stringify(replayed.result)}`
    );
  }
  await writeFile(join(loaded.dir, 'cassette.json'), encoded);
  await writeFile(
    join(loaded.dir, 'task.json'),
    `${JSON.stringify({ ...recordedTask, cassette: 'cassette.json' }, null, 2)}\n`
  );
  return `Recorded ${loaded.task.id} on ${options.model}: ${cassette.exchanges.length} exchange(s); the recorded run ${recorded.result.pass ? 'passed' : `failed (${recorded.result.reason})`}.`;
}
