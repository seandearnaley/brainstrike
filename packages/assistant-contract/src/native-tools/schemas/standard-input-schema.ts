import { Schema } from 'effect';
import { type EffectToolInputSchema, toEffectInputJsonSchema } from './effect-tool-input.js';

/** Ordinary receiving boundary: preserves its excess-property policy, without provider null normalization. */
export function standardInputSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  options: {
    readonly onExcessProperty: 'error' | 'ignore';
    readonly jsonSchemaOnExcessProperty?: 'error' | 'ignore';
  } = { onExcessProperty: 'ignore' }
): EffectToolInputSchema<S['Type']> {
  const standard = Schema.toStandardSchemaV1(schema, {
    parseOptions: { onExcessProperty: options.onExcessProperty },
  })['~standard'];
  const view = ({ target }: { readonly target: string }) =>
    toEffectInputJsonSchema(schema, target, {
      onExcessProperty: options.jsonSchemaOnExcessProperty ?? options.onExcessProperty,
    });
  const props = {
    ...standard,
    jsonSchema: { input: view, output: view },
    vendor: 'brainstrike',
  } as const;
  // Mastra requires Standard Schema's inference-only types member; it has no runtime value.
  return { '~standard': props as EffectToolInputSchema<S['Type']>['~standard'] };
}
