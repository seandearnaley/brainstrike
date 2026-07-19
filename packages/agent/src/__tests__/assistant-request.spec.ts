import { describe, expect, it } from 'vitest';
import { AssistantMessageValidationError } from '../assistant-message-boundary';
import {
  AssistantInvalidJsonError,
  AssistantRequestBodyLimitConfigError,
  AssistantRequestBodyTooLargeError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  hasNonEmptyAssistantPrompt,
  parseAssistantRequestPayloadText,
  readRequestBodyText,
  resolveAssistantRequestBodyLimitBytes,
} from '../assistant-request';
import type { AgentMessage } from '../types';

describe('assistant request helpers', () => {
  it('pins the default body limit with headroom for image attachments', () => {
    // Sized against the attachment contract: the combined per-message
    // attachment cap (10MB raw) base64-encodes to ~13.4MB, leaving ~2.6MB of
    // prompt/history headroom inside 16MB. Env-overridable via
    // BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES; overflow stays loud.
    expect(DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES).toBe(16 * 1024 * 1024);
  });

  it('uses the default request body byte limit when no override is configured', () => {
    expect(resolveAssistantRequestBodyLimitBytes(undefined)).toBe(
      DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
    expect(resolveAssistantRequestBodyLimitBytes('')).toBe(
      DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
  });

  it('accepts a positive integer request body byte limit override', () => {
    expect(resolveAssistantRequestBodyLimitBytes('5')).toBe(5);
  });

  it.each([
    '0',
    '-1',
    '1.5',
    'not-a-number',
  ])('throws for invalid request body byte limit override %s', (value) => {
    expect(() => resolveAssistantRequestBodyLimitBytes(value)).toThrow(
      'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES must be a positive integer byte count'
    );
    expect(() => resolveAssistantRequestBodyLimitBytes(value)).toThrow(
      AssistantRequestBodyLimitConfigError
    );
  });

  it('rejects declared oversized request bodies before reading', async () => {
    const req = new Request('http://localhost/api/chat', {
      headers: { 'content-length': '6' },
      method: 'POST',
    });

    await expect(readRequestBodyText(req, 5)).rejects.toThrow(
      'Assistant request body exceeds 5 bytes.'
    );
    await expect(readRequestBodyText(req, 5)).rejects.toBeInstanceOf(
      AssistantRequestBodyTooLargeError
    );
  });

  it('returns an empty body when the request has no stream', async () => {
    const req = new Request('http://localhost/api/chat', { method: 'POST' });

    await expect(readRequestBodyText(req, 5)).resolves.toBe('');
  });

  it('reads streamed request body text within the byte limit', async () => {
    const req = new Request('http://localhost/api/chat', {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.enqueue(new TextEncoder().encode(' world'));
          controller.close();
        },
      }),
      duplex: 'half',
      method: 'POST',
    } as RequestInit & { duplex: 'half' });

    await expect(readRequestBodyText(req, 20)).resolves.toBe('hello world');
  });

  it('rejects chunked request bodies when the streamed bytes exceed the limit', async () => {
    const req = new Request('http://localhost/api/chat', {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.enqueue(new TextEncoder().encode('!'));
          controller.close();
        },
      }),
      duplex: 'half',
      method: 'POST',
    } as RequestInit & { duplex: 'half' });

    await expect(readRequestBodyText(req, 5)).rejects.toThrow(
      'Assistant request body exceeds 5 bytes.'
    );
  });

  it('parses empty and non-object request payloads to an empty transport payload', () => {
    expect(parseAssistantRequestPayloadText('')).toEqual({
      data: undefined,
      rawMessages: [],
      runConfig: undefined,
    });
    expect(parseAssistantRequestPayloadText('null')).toEqual({
      data: undefined,
      rawMessages: [],
      runConfig: undefined,
    });
  });

  it('extracts runtime data, messages, and run config from valid payload JSON', () => {
    const payload = parseAssistantRequestPayloadText(
      JSON.stringify({
        data: { memory: { resourceId: 'workspace', threadId: 'thread' } },
        messages: [{ content: [{ text: 'hello', type: 'text' }], role: 'user' }],
        runConfig: { maxTokens: 128 },
        unstable_assistantMessageId: 'assistant-client-id',
      })
    );

    expect(payload).toMatchObject({
      assistantMessageId: 'assistant-client-id',
      data: { memory: { resourceId: 'workspace', threadId: 'thread' } },
      rawMessages: [{ role: 'user' }],
      runConfig: { maxTokens: 128 },
    });
  });

  it('rejects a non-array messages field instead of silently dropping it', () => {
    expect(() =>
      parseAssistantRequestPayloadText(
        JSON.stringify({
          data: { provider: 'openai' },
          messages: { role: 'user' },
          runConfig: false,
        })
      )
    ).toThrow(AssistantMessageValidationError);
  });

  it('throws a typed invalid-json error for malformed request JSON', () => {
    expect(() => parseAssistantRequestPayloadText('{')).toThrow(AssistantInvalidJsonError);
    expect(() => parseAssistantRequestPayloadText('{')).toThrow('Request body must be valid JSON.');
  });

  it('throws a typed message validation error for an invalid assistant message id', () => {
    const parseInvalidId = () =>
      parseAssistantRequestPayloadText(
        JSON.stringify({
          messages: [{ role: 'user', text: 'hello' }],
          unstable_assistantMessageId: 42,
        })
      );

    expect(parseInvalidId).toThrow(AssistantMessageValidationError);
    expect(parseInvalidId).toThrow('Assistant message id must be a non-empty bounded string.');
  });

  it('detects whether the latest assistant prompt has non-empty text', () => {
    const emptyPrompt: AgentMessage = {
      id: 'prompt-empty',
      parts: [{ text: '   ', type: 'text' }],
      role: 'user',
    };
    const nonTextPrompt: AgentMessage = {
      id: 'prompt-non-text',
      parts: [{ data: 'abc', mediaType: 'text/plain', type: 'file' }],
      role: 'user',
    };
    const nonEmptyPrompt: AgentMessage = {
      id: 'prompt-non-empty',
      parts: [{ text: '  summarize this  ', type: 'text' }],
      role: 'user',
    };

    expect(hasNonEmptyAssistantPrompt([])).toBe(false);
    expect(hasNonEmptyAssistantPrompt([nonEmptyPrompt, emptyPrompt])).toBe(false);
    expect(hasNonEmptyAssistantPrompt([nonTextPrompt])).toBe(false);
    expect(hasNonEmptyAssistantPrompt([emptyPrompt, nonEmptyPrompt])).toBe(true);
  });
});
