import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUN_VERDICT_DETAIL_MAX_CHARS,
  RUN_VERDICT_KEY,
  RUN_VERDICT_STDOUT_SCAN_CHARS,
  scanStdoutForRunVerdict,
} from '../../assistant-server/hooks/run-verdict';
import { isWithinRoot, normalizeWorkspacePath } from '../../assistant-server/workspace-path';
import { handleParseRequest } from '../../parser-host-entry';
import {
  extractParserHostRequestId,
  isParserHostParseRequest,
  type ParserHostParseOptions,
} from '../../parser-host-shared';

const SEED = 0x42_53_54_52;
const COUNTS = { parserEnvelope: 256, parserSource: 1024, path: 512, runVerdict: 256 };
const MAX_SEGMENT_CHARS = 64;
const MAX_PATH_CHARS = 1024;
const MAX_SOURCE_CHARS = 4096;
const MAX_AGGREGATE_SOURCE_CHARS = 2 * 1024 * 1024;

type Random = () => number;

function createRandom(seed = SEED): Random {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function createCases(): Readonly<
  Record<keyof typeof COUNTS, readonly { id: string; value: number }[]>
> {
  const random = createRandom();
  const result = {
    parserEnvelope: [] as { id: string; value: number }[],
    parserSource: [] as { id: string; value: number }[],
    path: [] as { id: string; value: number }[],
    runVerdict: [] as { id: string; value: number }[],
  };
  const names: readonly [keyof typeof COUNTS, string][] = [
    ['path', 'path'],
    ['runVerdict', 'run-verdict'],
    ['parserEnvelope', 'parser-envelope'],
    ['parserSource', 'parser-source'],
  ];
  for (const [key, label] of names) {
    for (let index = 0; index < COUNTS[key]; index += 1) {
      const value = random();
      result[key].push({
        id: `${label}:${String(index).padStart(4, '0')}:${value.toString(16).padStart(8, '0')}`,
        value,
      });
    }
  }
  return result;
}

const cases = createCases();

function generatedPath(value: number, index: number): string {
  const separators = ['/', '\\', '//', '\\\\'];
  const segments = ['', '.', '..', '..hidden', '..__..__var', `seg-${value.toString(36)}`];
  const count = 1 + (value % 12);
  const parts: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const segment = segments[(value + index + offset) % segments.length] ?? 'segment';
    parts.push(segment.slice(0, MAX_SEGMENT_CHARS));
  }
  const separator = separators[(value >>> 8) % separators.length] ?? '/';
  return `${index % 3 === 0 ? separator : ''}${parts.join(separator)}`.slice(0, MAX_PATH_CHARS);
}

function wholeSegments(value: string): string[] {
  return value.split('/').filter(Boolean);
}

describe('deterministic boundary crash fuzzer paths', () => {
  for (const [index, fuzzCase] of cases.path.entries()) {
    it(fuzzCase.id, () => {
      const input = generatedPath(fuzzCase.value, index);
      const normalized = normalizeWorkspacePath(input);
      expect(normalized).not.toContain('\\');
      expect(wholeSegments(normalized)).not.toContain('.');
      expect(wholeSegments(normalized)).not.toContain('..');
      expect(normalizeWorkspacePath(normalized)).toBe(normalized);

      const root = path.resolve(path.sep, 'synthetic-root');
      const childName = index % 2 === 0 ? '..hidden' : '..__..__var';
      const descendant = path.join(root, childName, `case-${index}`);
      expect(isWithinRoot(root, descendant)).toBe(true);
      expect(isWithinRoot(root, path.dirname(root))).toBe(false);
      expect(isWithinRoot(root, `${root}-sibling`)).toBe(false);
    });
  }
});

function verdictStdout(
  value: number,
  index: number
): { candidateLines: number; secret: string; stdout: string } {
  const secret = `synthetic-secret-${value.toString(16)}-${index}`;
  const detail = 'd'.repeat(value % (RUN_VERDICT_DETAIL_MAX_CHARS + 2));
  const valid = JSON.stringify({
    [RUN_VERDICT_KEY]: { detail, verdict: ['succeeded', 'failed', 'mixed'][value % 3] },
  });
  const malformed = `{${RUN_VERDICT_KEY}:${secret}}`;
  const variants = [
    valid,
    malformed,
    JSON.stringify({ [RUN_VERDICT_KEY]: { extra: true, verdict: 'failed' } }),
    JSON.stringify({ [RUN_VERDICT_KEY]: { detail: 42, verdict: 'failed' } }),
  ];
  const line = variants[index % variants.length] ?? malformed;
  const prefixLength = index % 5 === 0 ? RUN_VERDICT_STDOUT_SCAN_CHARS - (index % 17) : value % 80;
  const stdout = `${'x'.repeat(prefixLength)}\n${line}\ntrailer`;
  return { candidateLines: 1, secret, stdout };
}

describe('deterministic boundary crash fuzzer run verdicts', () => {
  for (const [index, fuzzCase] of cases.runVerdict.entries()) {
    it(fuzzCase.id, () => {
      const generated = verdictStdout(fuzzCase.value, index);
      const result = scanStdoutForRunVerdict(generated.stdout);
      expect(result.warnings.length).toBeLessThanOrEqual(generated.candidateLines);
      for (const warning of result.warnings) {
        expect(warning).not.toContain(generated.secret);
      }
      if (result.verdict?.detail !== undefined) {
        expect(result.verdict.detail.length).toBeLessThanOrEqual(RUN_VERDICT_DETAIL_MAX_CHARS);
      }
    });
  }
});

function envelope(value: number, index: number): unknown {
  const valid = {
    content: `const value${index} = ${value};`,
    options: {
      errorRecovery: (value & 1) === 0,
      jsx: (value & 2) === 0,
      language: (value & 4) === 0 ? 'javascript' : 'typescript',
    },
    requestId: `request-${index}-${value.toString(16)}`,
  };
  const variants: unknown[] = [
    valid,
    null,
    value,
    `primitive-${value}`,
    [valid, { nested: [true, false, null] }],
    { ...valid, requestId: value },
    { ...valid, content: [value] },
    { ...valid, options: { ...valid.options, jsx: 'true' } },
  ];
  return variants[index % variants.length];
}

describe('deterministic boundary crash fuzzer parser envelopes', () => {
  for (const [index, fuzzCase] of cases.parserEnvelope.entries()) {
    it(fuzzCase.id, () => {
      const value = envelope(fuzzCase.value, index);
      const accepted = isParserHostParseRequest(value);
      const extracted = extractParserHostRequestId(value);
      expect(typeof extracted).toBe('string');
      if (accepted) {
        expect(typeof value.requestId).toBe('string');
        expect(typeof value.content).toBe('string');
        expect(['javascript', 'typescript']).toContain(value.options.language);
        expect(typeof value.options.jsx).toBe('boolean');
        expect(typeof value.options.errorRecovery).toBe('boolean');
      }
    });
  }
});

function generatedSource(value: number, index: number, options: ParserHostParseOptions): string {
  const identifier = `value_${index}_${value.toString(36)}`;
  const fragments = [
    `const ${identifier} = ${value};`,
    `function f_${index}(input${options.language === 'typescript' ? ': unknown' : ''}) { return input; }`,
    options.jsx ? `const view_${index} = <div data-case="${index}">${value}</div>;` : '',
    index % 7 === 0 ? 'if (' : '',
  ];
  return fragments.join('\n').slice(0, MAX_SOURCE_CHARS);
}

const DIALECTS: readonly ParserHostParseOptions[] = (['javascript', 'typescript'] as const).flatMap(
  (language) =>
    [false, true].flatMap((jsx) =>
      [false, true].map((errorRecovery) => ({ errorRecovery, jsx, language }))
    )
);

const parserSourceCases = cases.parserSource.map((fuzzCase, index) => {
  const options = DIALECTS[Math.floor(index / 128)]!;
  const content = generatedSource(fuzzCase.value, index, options);
  return { content, fuzzCase, index, options };
});
const aggregateSourceChars = parserSourceCases.reduce(
  (total, fuzzCase) => total + fuzzCase.content.length,
  0
);
expect(aggregateSourceChars).toBeGreaterThan(0);
expect(aggregateSourceChars).toBeLessThanOrEqual(MAX_AGGREGATE_SOURCE_CHARS);

describe('deterministic boundary crash fuzzer parser sources', () => {
  for (const { content, fuzzCase, index, options } of parserSourceCases) {
    it(fuzzCase.id, async () => {
      expect(content.length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
      const requestId = `parser-${index}-${fuzzCase.value.toString(16)}`;
      const response = await handleParseRequest({ content, options, requestId });
      expect(response.requestId).toBe(requestId);
      if (response.ok) {
        expect(Object.keys(response).sort()).toEqual(['ok', 'requestId', 'root']);
        expect(response.root).not.toBeNull();
        expect(typeof response.root).toBe('object');
      } else {
        expect(Object.keys(response).sort()).toEqual(['error', 'ok', 'requestId']);
        expect(typeof response.error).toBe('string');
      }
    });
  }
});
