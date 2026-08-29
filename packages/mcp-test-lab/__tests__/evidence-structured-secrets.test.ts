import { describe, expect, it } from 'vitest';
import {
  assertEvidenceMetadataSanitized,
  assertEvidenceTextSanitized,
  assertEvidenceValueSanitized,
  createEvidenceSanitizationSession,
  McpEvidenceSecretError,
} from '../src/evidence-structured-secrets';

const SECRET = ['opaque', 'private', 'value'].join('-');

function expectSecretText(text: string, pattern: RegExp = /prohibited/i): void {
  expect(() => assertEvidenceTextSanitized(text, '$.artifact')).toThrowError(pattern);
}

describe('bounded structured evidence sanitization', () => {
  it.each([
    `{"access_token":"${SECRET}"}`,
    `{"access\\u005ftoken":"${SECRET}"}`,
    `{"client_secret":"#"}`,
    `{"access_token":["${SECRET}"]}`,
    `{"body":"{\\"access_token\\":\\"${SECRET}\\"}"}`,
    JSON.stringify({ body: `{"ok":true}\n{"access_token":"${SECRET}"}` }),
    String.raw`\u007b\u0022access_token\u0022:\u0022opaque-private-value\u0022\u007d`,
  ])('rejects JSON, Unicode, nested, and serialized secret form %#', (text) => {
    expectSecretText(text);
  });

  it('rejects credentials in prefixed, multiline, balanced JSON', () => {
    expectSecretText(`INFO body={\n  "access_token":"${SECRET}"\n} trailing`);
    expectSecretText(`INFO body={\\"access_token\\":\\"${SECRET}\\"} trailing`);
  });

  it.each([
    'client_secret&#61;opaque-private-value',
    'client_secret&#x3d;opaque-private-value',
    'client_secret&equals;opaque-private-value',
    'client_secret&amp;#61;opaque-private-value',
    'client_secret%253Dopaque-private-value',
  ])('decodes rendered HTML or Markdown entities before scanning', (text) => {
    expectSecretText(text, /credential-assignment/i);
  });

  it('decodes layered Unicode escapes to a bounded fixed point', () => {
    expectSecretText(
      String.raw`\u005cu007b\u005cu0022access_token\u005cu0022:\u005cu0022opaque-private-value\u005cu0022\u005cu007d`
    );
  });

  it('fails closed when percent-encoded bytes are not valid UTF-8', () => {
    expect(() => assertEvidenceTextSanitized('safe%FF', '$.encoded')).toThrowError(
      /percent decoding failed/i
    );
  });

  it('scans decoded credential keys and accepts only empty or exact safe values', () => {
    for (const value of [null, '', [], {}, 'redacted', 'none', 'disabled']) {
      expect(() => assertEvidenceValueSanitized({ access_token: value }, '$')).not.toThrow();
    }
    for (const value of [0, [SECRET], { nested: SECRET }, 'redacted-extra']) {
      expect(() => assertEvidenceValueSanitized({ access_token: value }, '$')).toThrowError(
        /credential-assignment/i
      );
    }
  });

  it('scans untrusted property names without copying them into diagnostics', () => {
    const keySecret = `ghp_${'a'.repeat(36)}`;
    let caught: unknown;
    try {
      assertEvidenceValueSanitized({ [keySecret]: 'safe' }, '$.value');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpEvidenceSecretError);
    expect((caught as McpEvidenceSecretError).issue.path).toBe('$.value{0}.key');
    expect(String(caught)).not.toContain(keySecret);
    expect(JSON.stringify(caught)).not.toContain(keySecret);
  });

  it('keeps validated metadata paths but classifies keys in decoded string payloads', () => {
    expect(() =>
      assertEvidenceMetadataSanitized({ access_token: SECRET }, '$.schema')
    ).not.toThrow();
    expect(() =>
      assertEvidenceMetadataSanitized(`{"access_token":"${SECRET}"}`, '$.schema.details')
    ).toThrowError(/credential-assignment/i);
  });

  it('detects NPM_TOKEN after JSON key decoding without broad token/id matching', () => {
    expect(() => assertEvidenceValueSanitized({ NPM_TOKEN: SECRET }, '$')).toThrowError(
      /credential-assignment/i
    );
    expect(() =>
      assertEvidenceValueSanitized({ input_token: 42, request_id: 'safe' }, '$')
    ).not.toThrow();
  });

  it('fails closed on text, candidate-count, structured-depth, and node limits', () => {
    expect(() => assertEvidenceTextSanitized('a'.repeat(1_048_577), '$.large')).toThrowError(
      /text size exceeds/i
    );
    expect(() => assertEvidenceTextSanitized('{'.repeat(257), '$.candidates')).toThrowError(
      /candidate count exceeds/i
    );
    let nested: unknown = 'safe';
    for (let index = 0; index < 65; index += 1) {
      nested = [nested];
    }
    expect(() => assertEvidenceValueSanitized(nested, '$.deep')).toThrowError(
      /structured depth exceeds/i
    );
    expect(() =>
      assertEvidenceValueSanitized(
        Array.from({ length: 10_001 }, () => null),
        '$.nodes'
      )
    ).toThrowError(/node count exceeds/i);
  });

  it('counts balanced outer documents rather than every nested brace as a candidate', () => {
    const tools = Array.from({ length: 40 }, (_, index) => ({
      inputSchema: { properties: { value: { type: 'string' } }, type: 'object' },
      name: `tool-${index}`,
    }));
    expect(() =>
      assertEvidenceTextSanitized(`INFO tools/list -> ${JSON.stringify({ tools })}`, '$.tools')
    ).not.toThrow();
  });

  it('does not confuse literal backslash runs with serialized JSON depth', () => {
    for (const count of [5, 8]) {
      expect(() =>
        assertEvidenceTextSanitized(`INFO { path=${'\\'.repeat(count)}"safe`, '$.path')
      ).not.toThrow();
    }
  });

  it('shares cumulative text, node, and candidate budgets within a session', () => {
    const textSession = createEvidenceSanitizationSession();
    textSession.assertTextSanitized('a'.repeat(600_000), '$.first');
    expect(() => textSession.assertTextSanitized('b'.repeat(448_577), '$.second')).toThrowError(
      /cumulative text size exceeds/i
    );

    const nodeSession = createEvidenceSanitizationSession();
    nodeSession.assertValueSanitized(
      Array.from({ length: 6000 }, () => null),
      '$.first'
    );
    expect(() =>
      nodeSession.assertValueSanitized(
        Array.from({ length: 3999 }, () => null),
        '$.second'
      )
    ).toThrowError(/node count exceeds/i);

    const candidateSession = createEvidenceSanitizationSession();
    const candidates = `INFO ${Array.from({ length: 64 }, () => '{}').join(' ')}`;
    for (let index = 0; index < 4; index += 1) {
      candidateSession.assertTextSanitized(candidates, `$.batch[${index}]`);
    }
    expect(() => candidateSession.assertTextSanitized('INFO {}', '$.overflow')).toThrowError(
      /candidate count exceeds/i
    );
  });

  it('fails closed when serialized JSON decoding exceeds its depth bound', () => {
    let serialized = `{"access_token":"${SECRET}"}`;
    for (let index = 0; index < 6; index += 1) {
      serialized = JSON.stringify(serialized);
    }
    expect(() => assertEvidenceTextSanitized(serialized, '$.serialized')).toThrowError(
      /JSON nesting exceeds/i
    );
  });

  it('reports only a safe path, class, and index', () => {
    let caught: unknown;
    try {
      assertEvidenceTextSanitized(`client_secret=${SECRET}`, '$.cleanup.details');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpEvidenceSecretError);
    expect((caught as McpEvidenceSecretError).issue).toMatchObject({
      code: 'secret_detected',
      kind: 'credential-assignment',
      path: '$.cleanup.details',
    });
    expect(String(caught)).not.toContain(SECRET);
    expect(JSON.stringify(caught)).not.toContain(SECRET);
  });
});
