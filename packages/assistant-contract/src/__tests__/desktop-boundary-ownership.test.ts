import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { admittedPersonaConfigurationSchema } from '../admitted-child-configuration.js';
import { childExecutionConfigurationSchema } from '../child-execution-configuration.js';
import { childBranchSelectionSchema } from '../child-followup.js';
import { assistantChildInputSchema } from '../child-input.js';
import { ReadDeliverySchema } from '../context-provenance.js';
import { delegatedConversationBaselineSchema } from '../delegated-conversation-stream.js';
import { AssistantModelStepDataSchema } from '../model-step.js';
import { ProviderCatalogSchema } from '../provider-catalog-schema.js';

test('desktop child, provider and conversation boundaries have an Effect owner', () => {
  expect(
    [
      admittedPersonaConfigurationSchema,
      assistantChildInputSchema,
      childExecutionConfigurationSchema,
      childBranchSelectionSchema,
      ReadDeliverySchema,
      delegatedConversationBaselineSchema,
      AssistantModelStepDataSchema,
      ProviderCatalogSchema,
    ].every(Schema.isSchema)
  ).toBe(true);
});
