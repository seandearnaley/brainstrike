import { createHash } from 'node:crypto';

// Executable, bounded profile derived from the pinned official SDK everything
// server. The reference server consumes this object directly; its digest is
// therefore the digest of the behavior-defining data rather than a claim that
// Brainstrike executes the complete upstream source file.
export const OFFICIAL_EVERYTHING_PROFILE = Object.freeze({
  capabilities: Object.freeze({
    completions: Object.freeze({}),
    prompts: Object.freeze({ listChanged: true }),
    resources: Object.freeze({ listChanged: true, subscribe: true }),
    tools: Object.freeze({ listChanged: true }),
  }),
  completion: Object.freeze({ hasMore: false, total: 0, values: Object.freeze([]) }),
  prompt: Object.freeze({
    description: 'A simple prompt without arguments',
    message: 'This is a simple prompt for testing.',
    name: 'test_simple_prompt',
    title: 'Simple Test Prompt',
  }),
  resource: Object.freeze({
    description: 'A static text resource for testing',
    mimeType: 'text/plain',
    name: 'static-text',
    text: 'This is the content of the static text resource.',
    title: 'Static Text Resource',
    uri: 'test://static-text',
  }),
  server: Object.freeze({ name: 'mcp-conformance-test-server', version: '1.0.0' }),
  tools: Object.freeze({
    error: Object.freeze({
      description: 'Tests error response handling',
      message: 'This tool intentionally returns an error for testing',
      name: 'test_error_handling',
    }),
    simpleText: Object.freeze({
      description: 'Tests simple text content response',
      name: 'test_simple_text',
      text: 'This is a simple text response for testing.',
    }),
  }),
} as const);

export const OFFICIAL_EVERYTHING_PROFILE_SHA256 = createHash('sha256')
  .update(JSON.stringify(OFFICIAL_EVERYTHING_PROFILE))
  .digest('hex');
