import { Result, Schema } from 'effect';
import { expect, test } from 'vitest';
import type { z } from 'zod';
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
import catalog from '../provider-catalog.json' with { type: 'json' };
import { ProviderCatalogSchema } from '../provider-catalog-schema.js';
import * as oldAdmitted from './fixtures/e05/pre-effect-admitted-child-configuration.js';
import * as oldChild from './fixtures/e05/pre-effect-child-execution-configuration.js';
import * as oldFollowup from './fixtures/e05/pre-effect-child-followup.js';
import * as oldInput from './fixtures/e05/pre-effect-child-input.js';
import * as oldContext from './fixtures/e05/pre-effect-context-provenance.js';
import * as oldConversation from './fixtures/e05/pre-effect-delegated-conversation-stream.js';
import * as oldModel from './fixtures/e05/pre-effect-model-step.js';
import * as oldCatalog from './fixtures/e05/pre-effect-provider-catalog-schema.js';

const image = {
  data: 'data:image/png;base64,AQID',
  filename: 'evidence.png',
  mediaType: 'image/png',
  type: 'file',
};
const bases = [
  {
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
  },
  { model: 'model', planMode: false, provider: 'openai' },
  { model: { modelId: 'model', provider: 'openai' } },
  { id: ' input ', text: ' hello ' },
  { attachments: [image], id: 'image', text: '' },
  image,
  { ...image, filename: undefined },
  { kind: 'retry', messageId: ' message ' },
  { attachments: [image], createdAt: '2026-10-17T00:00:00Z', id: 'message', text: 'hello' },
  { headId: null, hostRunId: 'run', messages: [], runEvents: [], threadId: 'thread' },
  {
    approxOutputTokens: 1,
    content: 'hi',
    endLine: 1,
    path: 'a.ts',
    rootId: 'root',
    startLine: 1,
    totalLines: 1,
    truncated: false,
  },
  { messages: [], model: {}, stepNumber: 0, usage: {} },
  { delta: 'hello', type: 'text-delta' },
];
const corpus: unknown[] = [
  undefined,
  new Date(0),
  new Map(),
  new Set(),
  Number.NaN,
  Number.POSITIVE_INFINITY,
  null,
  false,
  0,
  '',
  [],
  {},
  ...bases.flatMap((value) => [value, { ...value, extra: true }, { ...value, extra: undefined }]),
  { id: 'empty', text: '' },
  { attachments: [{ ...image, extra: true }], id: 'bad-image', text: '' },
  {
    attachments: [{ ...image, extra: true }],
    createdAt: '2026-10-17T00:00:00Z',
    id: 'bad-image',
    text: '',
  },
  { model: 'model', planMode: false, provider: 'unknown-provider' },
  {
    model: 'model',
    modelSettings: { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    planMode: false,
    provider: 'openai',
  },
];
const subjects: ReadonlyArray<
  readonly [string, Schema.ConstraintDecoder<unknown>, z.ZodType, 'error' | 'ignore']
> = [
  [
    'persona',
    admittedPersonaConfigurationSchema,
    oldAdmitted.admittedPersonaConfigurationSchema,
    'error',
  ],
  [
    'execution',
    childExecutionConfigurationSchema,
    oldChild.childExecutionConfigurationSchema,
    'error',
  ],
  ['next-run', childNextRunSchema, oldChild.childNextRunSchema, 'error'],
  ['child-input', assistantChildInputSchema, oldInput.assistantChildInputSchema, 'error'],
  ['attachment', assistantChildAttachmentSchema, oldInput.assistantChildAttachmentSchema, 'error'],
  ['branch', childBranchSelectionSchema, oldFollowup.childBranchSelectionSchema, 'error'],
  ['user-message', childUserMessageSchema, oldConversation.childUserMessageSchema, 'ignore'],
  [
    'baseline',
    delegatedConversationBaselineSchema,
    oldConversation.delegatedConversationBaselineSchema,
    'ignore',
  ],
  ['read-delivery', ReadDeliverySchema, oldContext.ReadDeliverySchema, 'error'],
  ['model-step', AssistantModelStepDataSchema, oldModel.AssistantModelStepDataSchema, 'error'],
  [
    'model-stream',
    AssistantModelStreamPartSchema,
    oldModel.AssistantModelStreamPartSchema,
    'error',
  ],
];
for (const [name, schema, oracle, onExcessProperty] of subjects) {
  test.each(corpus.map((value, index) => ({ index, value })))(
    `${name} preserves wire case $index`,
    ({ value }) => {
      const before = oracle.safeParse(value);
      const after = Schema.decodeUnknownResult(schema, { onExcessProperty })(value);
      expect(Result.isSuccess(after)).toBe(before.success);
      if (before.success && Result.isSuccess(after)) {
        expect(after.success).toEqual(before.data);
      }
    }
  );
}

test('the complete provider catalog decodes identically to its previous strict grammar', () => {
  expect(
    Schema.decodeUnknownSync(ProviderCatalogSchema, { onExcessProperty: 'error' })(catalog)
  ).toEqual(oldCatalog.ProviderCatalogSchema.parse(catalog));
});

test('child follow-up composition retains the inherited input check', () => {
  const valid = {
    branch: { kind: 'retry', messageId: 'message' },
    id: 'input',
    text: ' hello ',
    threadId: 'child',
  };
  for (const value of [
    valid,
    { ...valid, branch: undefined },
    { id: 'input', text: 'hello', threadId: 'child' },
    { ...valid, text: ' ' },
    { ...valid, branch: { kind: 'forged' } },
    { ...valid, permissions: { yolo: true } },
  ]) {
    const runConfig = { custom: { [CHILD_FOLLOWUP_RUN_CONFIG_KEY]: value } };
    expect(readChildFollowupRunConfigAction(runConfig)).toEqual(
      oldFollowup.readChildFollowupRunConfigAction(runConfig)
    );
  }
});
