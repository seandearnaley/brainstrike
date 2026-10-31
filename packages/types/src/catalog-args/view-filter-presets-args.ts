import { Schema } from 'effect';
import type { ViewFilterPresetRequest } from '../view-filter-preset-types.ts';

const Icon = Schema.Literals([
  'file',
  'file-code',
  'file-text',
  'folder',
  'folder-open',
  'code',
  'settings',
  'database',
  'box',
  'user',
  'layout',
  'globe',
  'cpu',
  'palette',
  'flask-conical',
  'test-tube',
]);
const Patterns = Schema.mutable(Schema.Array(Schema.String));

/** One view filter preset request, decoded wherever it crosses a process boundary. */
export const ViewFilterPresetRequestSchema: Schema.Decoder<ViewFilterPresetRequest> = Schema.Union([
  Schema.Struct({ operation: Schema.Literal('list') }),
  Schema.Struct({
    input: Schema.Struct({
      description: Schema.optionalKey(Schema.String),
      excludes: Patterns,
      icon: Schema.optionalKey(Icon),
      includes: Patterns,
      name: Schema.String,
      useRegex: Schema.optionalKey(Schema.Boolean),
    }),
    operation: Schema.Literal('create'),
  }),
  Schema.Struct({
    id: Schema.String,
    input: Schema.Struct({
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      excludes: Schema.optionalKey(Patterns),
      icon: Schema.optionalKey(Icon),
      includes: Schema.optionalKey(Patterns),
      name: Schema.optionalKey(Schema.String),
      sortOrder: Schema.optionalKey(
        Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(Number.MIN_SAFE_INTEGER),
          Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
        )
      ),
      useRegex: Schema.optionalKey(Schema.Boolean),
    }),
    operation: Schema.Literal('update'),
  }),
  Schema.Struct({ id: Schema.String, operation: Schema.Literal('delete') }),
]);

export const parseViewFilterPresetRequest = Schema.decodeUnknownSync(
  ViewFilterPresetRequestSchema,
  { onExcessProperty: 'error' }
);
