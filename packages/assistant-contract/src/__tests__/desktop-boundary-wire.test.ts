import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { admittedPersonaConfigurationSchema } from '../admitted-child-configuration.js';
import {
  childExecutionConfigurationSchema,
  childNextRunSchema,
} from '../child-execution-configuration.js';
import {
  CHILD_FOLLOWUP_RUN_CONFIG_KEY,
  childBranchSelectionSchema,
  readChildFollowupRunConfigAction,
} from '../child-followup.js';
import { assistantChildAttachmentSchema, assistantChildInputSchema } from '../child-input.js';
import { ReadDeliverySchema } from '../context-provenance.js';
import {
  childUserMessageSchema,
  delegatedConversationBaselineSchema,
} from '../delegated-conversation-stream.js';
import { AssistantModelStepDataSchema, AssistantModelStreamPartSchema } from '../model-step.js';

type Decoder = Schema.ConstraintDecoder<unknown>;

const image = {
  data: 'data:image/png;base64,AQID',
  filename: 'evidence.png',
  mediaType: 'image/png',
  type: 'file',
};
const persona = {
  maxSteps: 2,
  persona: {
    allowedToolIds: ['brainstrike.readWorkspaceFile'],
    description: 'Description',
    id: 'reader',
    instructions: 'Instructions',
    label: 'Reader',
    maxSteps: 2,
    mode: 'read-only',
    source: 'user',
  },
};
const execution = { model: 'model', planMode: false, provider: 'openai' };
const userMessage = {
  attachments: [image],
  createdAt: '2026-10-17T00:00:00Z',
  id: 'message',
  text: 'hello',
};
const baseline = {
  headId: null,
  hostRunId: 'run',
  messages: [],
  runEvents: [],
  threadId: 'thread',
};
const readDelivery = {
  approxOutputTokens: 1,
  content: 'hi',
  endLine: 1,
  path: 'a.ts',
  rootId: 'root',
  startLine: 1,
  totalLines: 1,
  truncated: false,
};

const decodeClosed = (schema: Decoder, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(value);

test.each([
  ['persona', admittedPersonaConfigurationSchema, persona, persona],
  ['execution', childExecutionConfigurationSchema, execution, execution],
  [
    'next-run',
    childNextRunSchema,
    { model: { modelId: 'model', provider: 'openai' } },
    { model: { modelId: 'model', provider: 'openai' } },
  ],
  [
    'child input',
    assistantChildInputSchema,
    { id: ' input ', text: ' hello ' },
    { id: 'input', text: 'hello' },
  ],
  [
    'child input with an image',
    assistantChildInputSchema,
    { attachments: [image], id: 'image', text: '' },
    { attachments: [image], id: 'image', text: '' },
  ],
  ['attachment', assistantChildAttachmentSchema, image, image],
  [
    'branch',
    childBranchSelectionSchema,
    { kind: 'retry', messageId: ' message ' },
    { kind: 'retry', messageId: 'message' },
  ],
  [
    'model step',
    AssistantModelStepDataSchema,
    { messages: [], model: {}, stepNumber: 0, usage: {} },
    { messages: [], model: {}, stepNumber: 0, usage: {} },
  ],
] as const)(
  '%s decodes its wire shape and rejects an excess key',
  (_name, schema, value, decoded) => {
    expect(decodeClosed(schema, value)).toEqual(decoded);
    expect(() => decodeClosed(schema, { ...value, extra: true })).toThrow();
  }
);

test.each([
  ['child input without text', assistantChildInputSchema, { id: 'empty', text: '' }],
  [
    'child input with an open attachment',
    assistantChildInputSchema,
    { attachments: [{ ...image, extra: true }], id: 'bad-image', text: '' },
  ],
  [
    'execution for an unknown provider',
    childExecutionConfigurationSchema,
    { ...execution, provider: 'unknown-provider' },
  ],
  [
    'execution with an unsafe output budget',
    childExecutionConfigurationSchema,
    { ...execution, modelSettings: { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 } },
  ],
] as const)('%s is rejected', (_name, schema, value) => {
  expect(() => decodeClosed(schema, value)).toThrow();
});

test('persisted conversation records drop unknown keys on read-back', () => {
  const read = (schema: Decoder, value: unknown) =>
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'ignore' })(value);
  expect(read(childUserMessageSchema, { ...userMessage, extra: true })).toEqual(userMessage);
  expect(read(delegatedConversationBaselineSchema, { ...baseline, extra: true })).toEqual(baseline);
});

test('read deliveries and model stream parts keep unknown keys', () => {
  expect(decodeClosed(ReadDeliverySchema, { ...readDelivery, extra: true })).toEqual({
    ...readDelivery,
    extra: true,
  });
  expect(
    decodeClosed(AssistantModelStreamPartSchema, {
      delta: 'hello',
      extra: true,
      type: 'text-delta',
    })
  ).toEqual({ delta: 'hello', extra: true, type: 'text-delta' });
});

test('a child follow-up keeps the child input check', () => {
  const valid = {
    branch: { kind: 'retry', messageId: 'message' },
    id: 'input',
    text: ' hello ',
    threadId: 'child',
  };
  const read = (value: unknown) =>
    readChildFollowupRunConfigAction({ custom: { [CHILD_FOLLOWUP_RUN_CONFIG_KEY]: value } });
  expect(read(valid)).toEqual({
    action: {
      branch: { kind: 'retry', messageId: 'message' },
      id: 'input',
      text: 'hello',
      threadId: 'child',
    },
  });
  for (const unbranched of [
    { ...valid, branch: undefined },
    { id: 'input', text: 'hello', threadId: 'child' },
  ]) {
    expect(read(unbranched)).toEqual({ action: { id: 'input', text: 'hello', threadId: 'child' } });
  }
  for (const invalid of [
    { ...valid, text: ' ' },
    { ...valid, branch: { kind: 'forged' } },
    { ...valid, permissions: { yolo: true } },
  ]) {
    expect(read(invalid)).toEqual({ invalid: true });
  }
});
