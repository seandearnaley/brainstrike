/**
 * Input schema for the project memory tool (ADR-0040): Anthropic's memory
 * tool commands (`memory_20250818`), field for field, so a run on Anthropic
 * declares the native tool and every other provider gets the same commands as
 * an ordinary function tool.
 */
import { Schema, SchemaIssue } from 'effect';

/**
 * The longest note the memory tool stores: Anthropic's memory `view` shows
 * this many characters before it truncates (ADR-0040).
 */
export const MEMORY_NOTE_MAX_CHARS = 16_000;
const MEMORY_PATH_MAX = 300;

const memoryPathValue = Schema.String.check(
  Schema.isMinCodePoints(1),
  Schema.isMaxLength(MEMORY_PATH_MAX)
);
const memoryPath = (description: string) =>
  Schema.optionalKey(Schema.NullOr(memoryPathValue)).annotate({ description });

/** Each command with the fields it needs; the flat schema below is checked against it. */
const MemoryCommandSchema = Schema.Union(
  [
    Schema.Struct({ command: Schema.Literal('view'), path: memoryPathValue }),
    Schema.Struct({
      command: Schema.Literal('create'),
      ['file_text']: Schema.String,
      path: memoryPathValue,
    }),
    Schema.Struct({
      command: Schema.Literal('str_replace'),
      ['old_str']: Schema.String.check(Schema.isMinCodePoints(1)),
      path: memoryPathValue,
    }),
    Schema.Struct({
      command: Schema.Literal('insert'),
      ['insert_line']: Schema.Int,
      ['insert_text']: Schema.String,
      path: memoryPathValue,
    }),
    Schema.Struct({ command: Schema.Literal('delete'), path: memoryPathValue }),
    Schema.Struct({
      command: Schema.Literal('rename'),
      ['new_path']: memoryPathValue,
      ['old_path']: memoryPathValue,
    }),
  ],
  { mode: 'oneOf' }
);

/**
 * One flat object: a strict provider takes no union at the top of a schema,
 * so the check holds each command to its own fields.
 */
export const MemoryInputSchema = Schema.Struct({
  command: Schema.Literals([
    'view',
    'create',
    'str_replace',
    'insert',
    'delete',
    'rename',
  ]).annotate({ description: 'Memory command' }),
  ['file_text']: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(MEMORY_NOTE_MAX_CHARS)))
  ).annotate({ description: 'create: the whole note' }),
  ['insert_line']: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
  ).annotate({ description: 'insert: the line the text goes after; 0 is the top' }),
  ['insert_text']: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: 'insert: the text',
  }),
  ['new_path']: memoryPath('rename: where the note goes'),
  ['new_str']: Schema.optionalKey(Schema.NullOr(Schema.String)).annotate({
    description: 'str_replace: the replacement; omit to delete old_str',
  }),
  ['old_path']: memoryPath('rename: the note to move'),
  ['old_str']: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMinCodePoints(1)))
  ).annotate({ description: 'str_replace: text that occurs exactly once' }),
  path: memoryPath('A path under /memories, for every command but rename'),
  ['view_range']: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Int).check(Schema.isMinLength(2), Schema.isMaxLength(2)))
  ).annotate({ description: 'view: [first line, last line]; -1 reads to the end' }),
}).check(
  Schema.makeFilter((input) => {
    const present = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== null && value !== undefined)
    );
    const parsed = Schema.decodeUnknownResult(MemoryCommandSchema)(present, {
      onExcessProperty: 'ignore',
    });
    if (parsed._tag === 'Success') {
      return;
    }
    return SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues.map(
      (issue) => ({
        issue: issue.message,
        path: (issue.path ?? []).map((segment) =>
          typeof segment === 'object' ? segment.key : segment
        ),
      })
    );
  })
);

export type MemoryInput = typeof MemoryInputSchema.Type;
