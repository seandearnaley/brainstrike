import { describe, expect, it } from 'vitest';
import { scrubLikelySecretValues } from '../diagnostics/secret-scrub';

describe('scrubLikelySecretValues', () => {
  it('redacts an Anthropic/OpenAI-style API key (sk-...)', () => {
    const input = 'the key is sk-live-aaaaaaaaaaaaaaaaaaaa please rotate it';
    const result = scrubLikelySecretValues(input);
    expect(result.text).toContain('[redacted-secret:api-key]');
    expect(result.text).not.toContain('sk-live-aaaaaaaaaaaaaaaaaaaa');
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['api-key']);
  });

  it('redacts an AWS access key id', () => {
    const input = 'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP';
    const result = scrubLikelySecretValues(input);
    expect(result.text).toContain('[redacted-secret:aws-access-key]');
    expect(result.text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['aws-access-key']);
  });

  it('redacts a classic GitHub personal access token (ghp_...)', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const result = scrubLikelySecretValues(`token: ${token}`);
    expect(result.text).toContain('[redacted-secret:github-token]');
    expect(result.text).not.toContain(token);
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['github-token']);
  });

  it('redacts a fine-grained GitHub token (github_pat_...)', () => {
    const token = `github_pat_${'a'.repeat(22)}`;
    const result = scrubLikelySecretValues(`token: ${token}`);
    expect(result.text).toContain('[redacted-secret:github-token]');
    expect(result.text).not.toContain(token);
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['github-token']);
  });

  it('redacts a Slack bot token (xoxb-...)', () => {
    const token = 'xoxb-1234567890-abcdefghijklmnop';
    const result = scrubLikelySecretValues(`slack: ${token}`);
    expect(result.text).toContain('[redacted-secret:slack-token]');
    expect(result.text).not.toContain(token);
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['slack-token']);
  });

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = scrubLikelySecretValues(`Authorization payload: ${jwt}`);
    expect(result.text).toContain('[redacted-secret:jwt]');
    expect(result.text).not.toContain(jwt);
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['jwt']);
  });

  it('redacts a Bearer token header', () => {
    const header = `Bearer ${'a1B2-c3D4_e5F6~g7H8.'.repeat(2)}`;
    const result = scrubLikelySecretValues(`Authorization: ${header}`);
    expect(result.text).toContain('[redacted-secret:bearer-token]');
    expect(result.text).not.toContain(header);
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['bearer-token']);
  });

  it('redacts a PEM private key block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAy...fixture...',
      'more base64 fixture lines here',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = scrubLikelySecretValues(`key:\n${pem}\ndone`);
    expect(result.text).toContain('[redacted-secret:private-key]');
    expect(result.text).not.toContain('MIIEowIBAAKCAQEAy');
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['private-key']);
  });

  it('redacts only the scheme://user:pass@ prefix of a database connection string', () => {
    const input = 'DATABASE_URL=postgres://appuser:s3cr3t-pass@db.internal:5432/prod';
    const result = scrubLikelySecretValues(input);
    expect(result.text).toBe('DATABASE_URL=[redacted-secret:db-credentials]db.internal:5432/prod');
    expect(result.text).not.toContain('appuser');
    expect(result.text).not.toContain('s3cr3t-pass');
    expect(result.text).toContain('db.internal:5432/prod');
    expect(result.redactedCount).toBe(1);
    expect(result.kinds).toEqual(['db-credentials']);
  });

  it('redacts multiple distinct secrets and reports deduped, sorted kinds', () => {
    const input = 'key sk-live-aaaaaaaaaaaaaaaaaaaa and AKIAABCDEFGHIJKLMNOP';
    const result = scrubLikelySecretValues(input);
    expect(result.redactedCount).toBe(2);
    expect(result.kinds).toEqual(['api-key', 'aws-access-key']);
  });

  it('leaves a UUID untouched', () => {
    const input = 'request id: 3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const result = scrubLikelySecretValues(input);
    expect(result.text).toBe(input);
    expect(result.redactedCount).toBe(0);
    expect(result.kinds).toEqual([]);
  });

  it('leaves an ordinary sentence untouched', () => {
    const input = 'The build failed because the checkout step timed out after 30 seconds.';
    const result = scrubLikelySecretValues(input);
    expect(result.text).toBe(input);
    expect(result.redactedCount).toBe(0);
  });

  it('leaves a short sk- prefixed string untouched (below the length floor)', () => {
    const input = 'variant name: sk-abcde';
    const result = scrubLikelySecretValues(input);
    expect(result.text).toBe(input);
    expect(result.redactedCount).toBe(0);
  });

  it('leaves a data URL untouched', () => {
    const input =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const result = scrubLikelySecretValues(input);
    expect(result.text).toBe(input);
    expect(result.redactedCount).toBe(0);
  });
});
