import { LogLevel, type LogRecord } from '@brainstrike/logging';
import { describe, expect, it } from 'vitest';
import {
  getLogRecordCauseChainDiagnostics,
  serializeLogContextJson,
  serializeLogRecordJson,
} from '../log-diagnostic-metadata';

function createRecord(context: Record<string, unknown>): LogRecord {
  return {
    args: [context],
    bindings: {},
    level: LogLevel.ERROR,
    timestamp: 1,
  };
}

describe('log diagnostic metadata', () => {
  it('preserves repeated sibling references while marking real cycles', () => {
    const shared = { status: 'shared' };
    const cyclic: Record<string, unknown> = { status: 'cyclic' };
    cyclic['self'] = cyclic;

    const serialized = serializeLogContextJson({
      cyclic,
      first: shared,
      second: shared,
    });

    expect(JSON.parse(serialized)).toEqual({
      cyclic: { self: '[Circular]', status: 'cyclic' },
      first: { status: 'shared' },
      second: { status: 'shared' },
    });
  });

  it('represents unsupported JSON values explicitly', () => {
    const serialized = serializeLogContextJson({
      functionValue() {},
      infinite: Number.POSITIVE_INFINITY,
      nan: Number.NaN,
      negativeInfinite: Number.NEGATIVE_INFINITY,
      symbolValue: Symbol('diagnostic'),
      undefinedValue: undefined,
    });

    expect(JSON.parse(serialized)).toEqual({
      functionValue: '[Function functionValue]',
      infinite: '[Infinity]',
      nan: '[NaN]',
      negativeInfinite: '[-Infinity]',
      symbolValue: 'Symbol(diagnostic)',
      undefinedValue: '[Undefined]',
    });
  });

  it('keeps malformed binding properties visible instead of aborting record serialization', () => {
    const bindings: Record<string, unknown> = {};
    Object.defineProperty(bindings, 'broken', {
      enumerable: true,
      get: () => {
        throw new Error('binding getter failed');
      },
    });
    const record = createRecord({});
    record.bindings = bindings;

    expect(JSON.parse(serializeLogRecordJson(record)).bindings).toEqual({
      broken: '[Bindings serialization failed]',
    });
  });

  it('marks an unreadable bindings proxy instead of aborting record serialization', () => {
    const record = createRecord({});
    record.bindings = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('binding keys failed');
        },
      }
    );

    expect(JSON.parse(serializeLogRecordJson(record)).bindings).toBe(
      '[Bindings serialization failed]'
    );
  });

  it('keeps valid causes and reports malformed entries instead of dropping the chain', () => {
    const diagnostics = getLogRecordCauseChainDiagnostics(
      createRecord({
        causeChain: [
          { code: null, message: 'Root failed', name: 'RootError' },
          { code: 42, message: 'Malformed', name: 'BadCodeError' },
          { code: 'E_VALID', message: 'Outer failed', name: 'OuterError' },
        ],
      })
    );

    expect(diagnostics).toEqual({
      entries: [
        { message: 'Root failed', name: 'RootError' },
        { code: 'E_VALID', message: 'Outer failed', name: 'OuterError' },
      ],
      malformedEntryCount: 1,
    });
  });
});
