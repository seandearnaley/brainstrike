/**
 * What every provider cassette recording must pass before it is saved, on
 * either recording route (the host lane or the desktop app): it holds no local
 * path and not the recorder's key, and the repository's own secret scanner
 * finds nothing in it. See docs/agents/provider-cassettes.md.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import {
  encodeProviderCassette,
  PROVIDER_CASSETTE_UPSTREAMS,
  type ProviderCassette,
  type ProviderCassetteFinding,
  type ProviderCassetteKnob,
  providerCassetteFindings,
} from '@brainstrike/test-utils/provider-cassette';

const UPSTREAMS_ENV = 'BRAINSTRIKE_PROVIDER_CASSETTE_UPSTREAMS';

/**
 * Where a recording's requests go: each knob's real provider, unless
 * `BRAINSTRIKE_PROVIDER_CASSETTE_UPSTREAMS` (JSON, knob to base URL) points a
 * knob at a local stand-in, to try a recording route offline as
 * `cassettes:proxy --upstream` does.
 */
export function recordingUpstreams(): Readonly<Record<ProviderCassetteKnob, string>> {
  const override = process.env[UPSTREAMS_ENV];
  if (!override) {
    return PROVIDER_CASSETTE_UPSTREAMS;
  }
  const parsed: unknown = JSON.parse(override);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${UPSTREAMS_ENV} must be a JSON object of knob to base URL.`);
  }
  const upstreams: Record<ProviderCassetteKnob, string> = { ...PROVIDER_CASSETTE_UPSTREAMS };
  for (const [knob, url] of Object.entries(parsed)) {
    if (!(knob in upstreams) || typeof url !== 'string') {
      throw new Error(`${UPSTREAMS_ENV} names an unknown knob or a non-string URL: ${knob}`);
    }
    upstreams[knob as ProviderCassetteKnob] = url;
  }
  return upstreams;
}

/**
 * The recording's local paths and key, if it holds any. A disposable workspace
 * path a model echoes is not private; whether the recording still replays is
 * the replay's to say.
 */
export function recordingFindings(
  cassette: ProviderCassette,
  key: string
): readonly ProviderCassetteFinding[] {
  return providerCassetteFindings(cassette, [
    { rule: 'home-directory', value: homedir() },
    { rule: 'user-name', value: userInfo().username },
    { rule: 'recorder-credential', value: key },
  ]);
}

/** The repository's own secret scanner (`--files`), run over the encoded cassette outside the repo. */
const SECRET_SCAN = resolve(import.meta.dirname, '../../../../scripts/secret-scan.mjs');

/** The secret scanner's report on the encoded cassette; empty when clean. */
export async function secretScan(cassette: ProviderCassette): Promise<string> {
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
