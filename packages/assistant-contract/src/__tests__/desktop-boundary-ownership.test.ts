import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { childExecutionConfigurationSchema } from '../child-execution-configuration.js';
import { assistantChildInputSchema } from '../child-input.js';
import { ReadDeliverySchema } from '../context-provenance.js';
import { AssistantModelStepDataSchema } from '../model-step.js';
import { ProviderCatalogSchema } from '../provider-catalog-schema.js';

test('desktop child, provider and conversation boundaries have an Effect owner', () => {
  expect(
    [
      assistantChildInputSchema,
      childExecutionConfigurationSchema,
      ReadDeliverySchema,
      AssistantModelStepDataSchema,
      ProviderCatalogSchema,
    ].every(Schema.isSchema)
  ).toBe(true);
});
