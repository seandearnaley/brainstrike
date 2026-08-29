import { describe, expect, it } from 'vitest';
import { scanEvidenceTextForSecrets } from '../src/evidence-secrets';

function kinds(text: string): readonly string[] {
  return scanEvidenceTextForSecrets(text).map((finding) => finding.kind);
}

describe('scanEvidenceTextForSecrets', () => {
  it.each([
    ['bearer-token', 'Authorization: Bearer opaque-value'],
    ['basic-credential', 'Authorization: Basic dXNlcjpwYXNz'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl'],
    ['private-key', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nopaque'],
    ['github-token', `github_pat_${'a'.repeat(82)}`],
    ['aws-access-key-id', ['AKIA', '1234567890ABCDEF'].join('')],
    ['npm-token', `npm_${'a'.repeat(36)}`],
  ])('detects %s material without returning its value', (kind, secret) => {
    const findings = scanEvidenceTextForSecrets(`prefix ${secret} suffix`);
    expect(findings).toContainEqual(expect.objectContaining({ kind }));
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it.each([
    ['access_token', 'credential-assignment'],
    ['api_key', 'credential-assignment'],
    ['auth_code', 'authorization-code'],
    ['authorization_code', 'authorization-code'],
    ['client_secret', 'credential-assignment'],
    ['code_verifier', 'pkce-verifier'],
    ['password', 'credential-assignment'],
    ['pkce_verifier', 'pkce-verifier'],
    ['refresh_token', 'credential-assignment'],
  ])('detects an exact or namespaced %s assignment as %s', (key, expectedKind) => {
    expect(kinds(`${key}=opaque-value`)).toContain(expectedKind);
    expect(kinds(`service.${key}: opaque-value`)).toContain(expectedKind);
  });

  it.each([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_BEARER_TOKEN_BEDROCK',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
  ])('detects the repository-supported %s label in text and URLs', (key) => {
    expect(kinds(`${key}=opaque-value`)).not.toEqual([]);
    expect(kinds(`https://example.test/callback?${key}=opaque-value`)).toContain(
      'credential-bearing-url'
    );
  });

  it('detects URL userinfo plus query and fragment credential parameters', () => {
    for (const url of [
      'https://operator:password@example.test/callback',
      'https://example.test/callback?client-secret=opaque',
      'https://example.test/callback#access_token=opaque',
      'https://example.test/callback#route?code=opaque',
    ]) {
      expect(kinds(url)).toContain('credential-bearing-url');
    }
  });

  it('falls back to assignment scanning inside an unparseable URL-shaped value', () => {
    expect(kinds('https://example.test:bad/?client_secret=opaque-value')).toContain(
      'credential-assignment'
    );
  });

  it.each([
    '//registry.npmjs.org/:_authToken=opaque-value',
    '//npm.pkg.github.com/:_password=opaque-value',
    '_auth=opaque-value',
  ])('detects explicit npmrc credential directives: %s', (directive) => {
    expect(kinds(directive)).toContain('credential-assignment');
  });

  it('accepts safe sentinels only as the complete credential value', () => {
    for (const sentinel of ['disabled', 'none', 'redacted']) {
      expect(kinds(`client_secret=${sentinel}`)).toEqual([]);
      expect(kinds(`Authorization: Bearer ${sentinel}`)).toEqual([]);
      expect(kinds(`https://example.test/?client_secret=${sentinel}`)).toEqual([]);
      expect(kinds(`client_secret=${sentinel}-extra`)).toContain('credential-assignment');
    }
    expect(kinds('client_secret="redacted)"')).toContain('credential-assignment');
  });

  it('does not classify generic token/id telemetry or safe diagnostics', () => {
    expect(
      kinds(
        'input_token=42 output_token=7 request_id=abc status_code=200 ' +
          'authorization=not-required-here exit code: INTERNAL_ERROR_XYZ'
      )
    ).toEqual([]);
  });

  it('does not classify authentication documentation as an authorization header', () => {
    expect(kinds('Bearer authentication is required for this endpoint')).toEqual([]);
    expect(kinds('Authorization: Basic authentication is disabled')).toEqual([]);
    expect(kinds('Authorization: Bearer token is required')).toEqual([]);
    expect(kinds('Authorization: Bearer token')).toContain('bearer-token');
    expect(kinds('Authorization: Bearer token-like-value')).toContain('bearer-token');
  });

  it('accepts authorization sentinels only as the complete header value', () => {
    expect(kinds('Authorization: Bearer redacted')).toEqual([]);
    expect(kinds('Authorization: Bearer none.')).toEqual([]);
    expect(kinds('{"authorization":"Bearer redacted"}')).toEqual([]);
    expect(kinds('{"authorization":"Bearer redacted","x":1}')).toEqual([]);
    expect(kinds('Authorization: Bearer redacted trailing')).toContain('bearer-token');
    expect(kinds('{"authorization":"Bearer redacted trailing"}')).toContain('bearer-token');
  });

  it('treats every non-sentinel Basic payload as credential material', () => {
    expect(kinds('Authorization: Basic dXNlcg==')).toContain('basic-credential');
    expect(kinds('Authorization: Basic not-base64')).toContain('basic-credential');
    expect(kinds('Authorization: Basic !!!')).toContain('basic-credential');
    expect(kinds('Authorization: Basic :')).toContain('basic-credential');
  });

  it('returns deterministic content-free findings', () => {
    const secret = 'opaque-private-value';
    const findings = scanEvidenceTextForSecrets(
      `client_secret=${secret} Authorization: Bearer ${secret}`
    );
    expect(findings.map((finding) => finding.index)).toEqual(
      [...findings].map((finding) => finding.index).sort((left, right) => left - right)
    );
    expect(JSON.stringify(findings)).not.toContain(secret);
  });
});
