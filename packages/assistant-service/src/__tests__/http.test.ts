/**
 * Executed wire-contract tests for the shared WHATWG rejection mapper
 * (BST-973 review finding: "byte-identical" was a type-compatibility
 * argument, not an executed assertion — web's route suite mocks the route
 * module, so nothing ran this path on either host).
 */
import { describe, expect, it } from 'vitest';
import { ASSISTANT_JSON_ERROR_HEADERS, createAssistantRejectionResponse } from '../http';

describe('createAssistantRejectionResponse', () => {
  it('serializes status, both headers, and the exact payload bytes', async () => {
    const response = createAssistantRejectionResponse({
      payload: { error: 'invalid_json', message: 'Request body must be valid JSON.' },
      status: 400,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(await response.text()).toBe(
      '{"error":"invalid_json","message":"Request body must be valid JSON."}'
    );
  });

  it('keeps the message-less empty_prompt payload message-less on the wire', async () => {
    const response = createAssistantRejectionResponse({
      payload: { error: 'empty_prompt' },
      status: 400,
    });

    expect(await response.text()).toBe('{"error":"empty_prompt"}');
  });

  it('rejects a connection-close rejection at the type level (compile-time contract)', () => {
    // WHATWG hosts have no connection to instruct; silently dropping the
    // instruction is the NO SILENT FALLBACKS failure mode. The param type
    // makes it unrepresentable:
    createAssistantRejectionResponse({
      // @ts-expect-error closeConnection must not reach the WHATWG mapper
      closeConnection: true,
      payload: { error: 'request_body_too_large', message: 'too big' },
      status: 413,
    });
    expect(ASSISTANT_JSON_ERROR_HEADERS['Cache-Control']).toBe('no-store');
  });
});
