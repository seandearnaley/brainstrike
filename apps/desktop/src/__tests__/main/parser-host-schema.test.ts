import { describe, expect, it } from 'vitest';
import { isParserHostParseRequest, isParserHostParseResponse } from '../../parser-host-schema';

describe('parser host wire schemas', () => {
  it('accepts a valid request with extra metadata without projecting it', () => {
    const request = {
      content: 'const value = 1',
      options: { errorRecovery: false, jsx: false, language: 'typescript', parserHint: 'opaque' },
      requestId: 'request-1',
      trace: 'opaque',
    };

    expect(isParserHostParseRequest(request)).toBe(true);
    expect(request.options.parserHint).toBe('opaque');
  });

  it('requires declared request fields and rejects array-shaped objects', () => {
    const request = {
      content: 'source',
      options: { errorRecovery: true, jsx: true, language: 'javascript' },
      requestId: 'request-1',
    };

    expect(isParserHostParseRequest(request)).toBe(true);
    expect(isParserHostParseRequest({ ...request, content: 42 })).toBe(false);
    expect(
      isParserHostParseRequest({ ...request, options: { ...request.options, jsx: 'yes' } })
    ).toBe(false);
    expect(isParserHostParseRequest(Object.assign([], request))).toBe(false);
    expect(
      isParserHostParseRequest({ ...request, options: Object.assign([], request.options) })
    ).toBe(false);
  });

  it('accepts optional root fields and leaves arbitrary AST descendants opaque', () => {
    const descendants = [{ deeplyNested: { text: 'private user source', type: 42 } }];
    const minimal = { ok: true, requestId: 'request-1', root: {} };
    const explicitlyUndefined = {
      ok: true,
      requestId: 'request-1',
      root: { end: undefined, start: undefined, type: undefined },
    };
    const rich = {
      ok: true,
      requestId: 'request-1',
      root: { body: descendants, end: 20, start: 0, type: 'Program' },
    };

    expect(isParserHostParseResponse(minimal)).toBe(true);
    expect(isParserHostParseResponse(explicitlyUndefined)).toBe(true);
    expect(isParserHostParseResponse(rich)).toBe(true);
    expect(rich.root.body).toBe(descendants);
    expect(isParserHostParseResponse({ ...rich, root: { ...rich.root, start: 'zero' } })).toBe(
      false
    );
  });

  it('requires the branch-specific response payload', () => {
    expect(
      isParserHostParseResponse({ error: 'parse error', ok: false, requestId: 'request-1' })
    ).toBe(true);
    expect(isParserHostParseResponse({ ok: true, requestId: 'request-1' })).toBe(false);
    expect(isParserHostParseResponse({ ok: false, requestId: 'request-1' })).toBe(false);
    expect(isParserHostParseResponse({ ok: true, requestId: 'request-1', root: [] })).toBe(false);
  });
});
