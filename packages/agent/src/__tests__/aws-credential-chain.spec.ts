/**
 * BST-1353 — the AWS default credential chain behind Bedrock's
 * `credentialProvider` seam.
 *
 * The EMPIRICAL block is the load-bearing half of this file. The failure
 * mapping must not be written against guessed SDK class names, so those tests
 * drive the REAL `@aws-sdk/credential-providers` chain against a bogus HOME /
 * profile directory and assert the classification we ship. They are hermetic:
 * temp dirs only, IMDS disabled (`AWS_EC2_METADATA_DISABLED`), and every
 * scenario fails before any network call — the SSO cases deliberately omit a
 * `refreshToken` so the SDK rejects locally instead of calling SSO OIDC.
 *
 * What the probe actually measured (SDK 3.1111.0, recorded in
 * aws-credential-chain.ts): EVERY chain failure is one class,
 * `CredentialsProviderError`; there is no distinct expired-SSO class, and the
 * class itself lives in `@smithy/property-provider`, which is not resolvable
 * from this package. Classification is therefore structural + message-based.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_CHAIN_NO_CREDENTIALS_HINT,
  createAwsCredentialChain,
  describeAwsChainFailure,
  resolveAwsCredentialChain,
} from '../providers/aws-credential-chain';

const SAVED_ENV = { ...process.env };

function clearAwsEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AWS_')) {
      delete process.env[name];
    }
  }
}

function restoreEnvironment(): void {
  for (const name of Object.keys(process.env)) {
    if (!Object.hasOwn(SAVED_ENV, name)) {
      delete process.env[name];
    }
  }
  Object.assign(process.env, SAVED_ENV);
}

/** A CredentialsProviderError look-alike: the SDK's class is not importable. */
function credentialsProviderError(message: string): Error {
  const error = new Error(message);
  error.name = 'CredentialsProviderError';
  return error;
}

describe('describeAwsChainFailure', () => {
  it('maps an expired SSO session to the aws sso login hint naming the profile', () => {
    const detail = describeAwsChainFailure(
      credentialsProviderError(
        "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile."
      ),
      'acme-dev'
    );

    expect(detail).toContain('AWS SSO session expired');
    expect(detail).toContain('aws sso login --profile acme-dev');
  });

  it('names the DEFAULT profile when the chain ran without an explicit profile', () => {
    const detail = describeAwsChainFailure(
      credentialsProviderError(
        'The SSO session associated with this profile is invalid. To refresh this SSO session run aws sso login with the corresponding profile.'
      ),
      undefined
    );

    expect(detail).toContain('aws sso login --profile default');
  });

  it('maps a no-credentials chain failure to actionable text naming the profile searched', () => {
    const detail = describeAwsChainFailure(
      credentialsProviderError('Could not load credentials from any providers'),
      'acme-dev'
    );

    expect(detail).toContain(AWS_CHAIN_NO_CREDENTIALS_HINT);
    expect(detail).toContain('acme-dev');
    // The two causes must stay DISTINCT: "nothing configured" must never
    // claim a session expired. It may still OFFER `aws sso login` as one of
    // three remedies — a user whose profile is SSO-backed but never logged in
    // lands here, and that is the fix.
    expect(detail).not.toContain('AWS SSO session expired');
  });

  // PR #2525 review, finding 7: the raw SDK message is upstream-controlled and
  // can carry file paths, ARNs, account ids, assumed-role names, or proxy
  // URLs. This string reaches the renderer and the settings row, so it maps to
  // a BOUNDED set of shapes; the raw text stays in the main-side log (it rides
  // the typed error's `cause`).
  it('maps an unrecognized failure to a bounded shape WITHOUT echoing the raw message', () => {
    const detail = describeAwsChainFailure(
      new Error('socket hang up while calling https://proxy.internal.acme.corp:8080'),
      'acme-dev'
    );

    expect(detail).toContain('acme-dev');
    expect(detail).toContain('could not reach the network');
    expect(detail).not.toContain('proxy.internal.acme.corp');
    expect(detail).not.toContain('socket hang up');
  });

  it('falls back to a generic line for a wholly unrecognized message', () => {
    const detail = describeAwsChainFailure(
      new Error('arn:aws:sts::123456789012:assumed-role/SecretRole/session exploded'),
      undefined
    );

    expect(detail).toContain('see the desktop logs');
    expect(detail).not.toContain('123456789012');
    expect(detail).not.toContain('SecretRole');
  });

  it('keeps the raw SDK text on the typed error CAUSE for main-side logging', async () => {
    const raw = new Error('arn:aws:sts::123456789012:assumed-role/SecretRole/session exploded');
    const thrown = await resolveAwsCredentialChain('acme-dev', () => Promise.reject(raw)).then(
      () => undefined,
      (error: unknown) => error
    );

    expect((thrown as { cause?: unknown }).cause).toBe(raw);
    expect((thrown as Error).message).not.toContain('SecretRole');
  });
});

describe('createAwsCredentialChain', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a per-request closure that resolves credentials from the chain', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAUNITTEST');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'unit-secret');

    const credentials = await createAwsCredentialChain(undefined)();

    expect(credentials.accessKeyId).toBe('AKIAUNITTEST');
    expect(credentials.secretAccessKey).toBe('unit-secret');
  });

  it('is a fresh closure per call — never a shared cached resolver', () => {
    expect(createAwsCredentialChain('a')).not.toBe(createAwsCredentialChain('a'));
  });

  it('is never serializable — JSON.stringify drops the closure entirely', () => {
    const auth = { credentialProvider: createAwsCredentialChain('acme'), region: 'us-east-1' };

    expect(JSON.parse(JSON.stringify(auth))).toEqual({ region: 'us-east-1' });
  });
});

describe('createAwsCredentialChain (EMPIRICAL — real AWS SDK, bogus HOME)', () => {
  let root: string;

  beforeEach(() => {
    clearAwsEnvironment();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bst1353-'));
    // Without this the chain would attempt IMDS at 169.254.169.254 and spend
    // its connect timeout before failing — hermetic tests must never do that.
    process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
  });

  afterEach(() => {
    restoreEnvironment();
    fs.rmSync(root, { force: true, recursive: true });
  });

  function useHome(name: string, files: Record<string, string> = {}): void {
    const home = path.join(root, name);
    fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
    for (const [relativePath, body] of Object.entries(files)) {
      const target = path.join(home, '.aws', relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    process.env['HOME'] = home;
    process.env['AWS_CONFIG_FILE'] = path.join(home, '.aws', 'config');
    process.env['AWS_SHARED_CREDENTIALS_FILE'] = path.join(home, '.aws', 'credentials');
  }

  const SSO_CONFIG = [
    '[profile ssoprof]',
    'sso_session = mysso',
    'sso_account_id = 123456789012',
    'sso_role_name = Dev',
    'region = us-east-1',
    '',
    '[sso-session mysso]',
    'sso_start_url = https://example.awsapps.com/start',
    'sso_region = us-east-1',
    'sso_registration_scopes = sso:account:access',
    '',
  ].join('\n');

  const ssoCacheEntry = (): Record<string, string> => ({
    [`sso/cache/${createHash('sha1').update('mysso').digest('hex')}.json`]: JSON.stringify({
      accessToken: 'expired-token',
      clientId: 'cid',
      clientSecret: 'csec',
      // Expired AND deliberately without a refreshToken: the SDK then rejects
      // locally with "Value not present for 'refreshToken'…" instead of
      // calling SSO OIDC, which keeps this test offline.
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      region: 'us-east-1',
      registrationExpiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      startUrl: 'https://example.awsapps.com/start',
    }),
  });

  it('classifies an EXPIRED SSO session as the actionable aws sso login failure', async () => {
    useHome('ssoexpired', { config: SSO_CONFIG, ...ssoCacheEntry() });

    await expect(createAwsCredentialChain('ssoprof')()).rejects.toThrow(
      /AWS SSO session expired.*aws sso login --profile ssoprof/s
    );
  });

  it('classifies an SSO profile that was never logged into as the same login failure', async () => {
    useHome('ssofresh', { config: SSO_CONFIG });

    await expect(createAwsCredentialChain('ssoprof')()).rejects.toThrow(
      /AWS SSO session expired.*aws sso login --profile ssoprof/s
    );
  });

  it('classifies a missing named profile as no-credentials-found, naming the profile', async () => {
    useHome('missing');

    await expect(createAwsCredentialChain('does-not-exist')()).rejects.toThrow(/does-not-exist/);
    await expect(createAwsCredentialChain('does-not-exist')()).rejects.toThrow(
      new RegExp(AWS_CHAIN_NO_CREDENTIALS_HINT)
    );
  });

  it('classifies an empty environment as no-credentials-found, naming the default profile', async () => {
    useHome('empty');

    await expect(createAwsCredentialChain(undefined)()).rejects.toThrow(
      new RegExp(AWS_CHAIN_NO_CREDENTIALS_HINT)
    );
    await expect(createAwsCredentialChain(undefined)()).rejects.toThrow(/default/);
  });

  it('honors the NAMED profile — a profile with static keys resolves them', async () => {
    useHome('named', {
      credentials: [
        '[default]',
        'aws_access_key_id = AKIADEFAULT',
        'aws_secret_access_key = default-secret',
        '',
        '[named]',
        'aws_access_key_id = AKIANAMED',
        'aws_secret_access_key = named-secret',
        '',
      ].join('\n'),
    });

    await expect(createAwsCredentialChain('named')()).resolves.toMatchObject({
      accessKeyId: 'AKIANAMED',
    });
    await expect(createAwsCredentialChain(undefined)()).resolves.toMatchObject({
      accessKeyId: 'AKIADEFAULT',
    });
  });
});
