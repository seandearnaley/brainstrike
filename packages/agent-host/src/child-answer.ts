import { Schema } from 'effect';

const RoleSchema = Schema.Struct({ role: Schema.String });
const AssistantContentSchema = Schema.Struct({
  content: Schema.Union([
    Schema.String,
    Schema.mutable(
      Schema.Array(
        Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ])
      )
    ),
  ]),
});
const TextPartSchema = Schema.Struct({ text: Schema.String, type: Schema.Literal('text') });
/**
 * The answer in a run's committed model messages: the trimmed text of the last
 * assistant message, or undefined when these messages hold none, so a fold
 * over a run's `model.step` events keeps the last one it saw. The one rule for
 * a child's answer, wherever its log is read: the host's delegation result and
 * the renderer's delegation card both report a completed child with an empty
 * answer as `no-answer`.
 */
export function hostAnswerText(messages: readonly unknown[]): string | undefined {
  const last = messages.findLast(
    (message) => Schema.decodeUnknownSync(RoleSchema)(message).role === 'assistant'
  );
  if (last === undefined) {
    return;
  }
  const { content } = Schema.decodeUnknownSync(AssistantContentSchema)(last);
  if (typeof content === 'string') {
    return content.trim();
  }
  return content
    .flatMap((part) =>
      part.type === 'text' ? [Schema.decodeUnknownSync(TextPartSchema)(part).text] : []
    )
    .join('')
    .trim();
}
